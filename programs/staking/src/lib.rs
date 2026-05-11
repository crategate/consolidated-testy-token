use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("DAQsZPfBs2Qd88sTZEEMh9ecwqwRAY66WgXZ6AcaVKnU");
#[program]
pub mod staking {
    use super::*;

    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        base_apy_bps: u16,
        max_multiplier_bps: u16,
        penalty_bps: u16,
        posr_tax_bps: u16,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;

        pool.authority = ctx.accounts.authority.key();
        pool.mint = ctx.accounts.mint.key();
        pool.vault = ctx.accounts.vault.key();
        pool.reward_vault = ctx.accounts.reward_vault.key();
        pool.posr_vault = ctx.accounts.posr_vault.key();
        pool.total_staked = 0;
        pool.base_apy_bps = base_apy_bps;
        pool.max_multiplier_bps = max_multiplier_bps;
        pool.penalty_bps = penalty_bps;
        pool.posr_tax_bps = posr_tax_bps;
        pool.market_status_pda = ctx.accounts.market_status_pda.key();
        pool.bump = ctx.bumps.pool;

        Ok(())
    }

    pub fn deposit_rewards(ctx: Context<DepositRewards>, amount: u64) -> Result<()> {
        require!(amount > 0, StakeError::ZeroAmount);

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.authority_token.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.reward_vault.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)
    }

    pub fn stake(ctx: Context<Stake>, amount: u64, index: u64) -> Result<()> {
        require!(amount > 0, StakeError::ZeroAmount);
        require!(amount >= 100, StakeError::MinStake);

        let pool = &mut ctx.accounts.pool;
        let position = &mut ctx.accounts.position;
        let user_index = &mut ctx.accounts.user_index;
        let clock = Clock::get()?;

        let trading_day_index = get_trading_day_index(&ctx.accounts.market_status)?;

        position.owner = ctx.accounts.owner.key();
        position.pool = pool.key();
        position.amount = amount;
        position.entry_trading_day = trading_day_index;
        position.last_claim_timestamp = clock.unix_timestamp;
        position.index = index;
        position.bump = ctx.bumps.position;

        user_index.next_index = user_index.next_index.max(index + 1);
        pool.total_staked += amount;

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.owner_token.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.owner.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let position = &mut ctx.accounts.position;
        let pool = &ctx.accounts.pool;
        let clock = Clock::get()?;

        let trading_day_index = get_trading_day_index(&ctx.accounts.market_status)?;

        let gross_rewards =
            calculate_rewards(position, pool, clock.unix_timestamp, trading_day_index);
        require!(gross_rewards > 0, StakeError::NoRewards);

        let posr_tax = gross_rewards * pool.posr_tax_bps as u64 / 10000;
        let user_rewards = gross_rewards - posr_tax;
        position.last_claim_timestamp = clock.unix_timestamp;

        let signer_seeds: &[&[&[u8]]] = &[&[b"pool", pool.mint.as_ref(), &[pool.bump]]];

        if user_rewards > 0 {
            let cpi = TransferChecked {
                from: ctx.accounts.reward_vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.owner_token.to_account_info(),
                authority: pool.to_account_info(),
            };
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi,
                    signer_seeds,
                ),
                user_rewards,
                ctx.accounts.mint.decimals,
            )?;
        }

        if posr_tax > 0 {
            let cpi = TransferChecked {
                from: ctx.accounts.reward_vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.posr_vault.to_account_info(),
                authority: pool.to_account_info(),
            };
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi,
                    signer_seeds,
                ),
                posr_tax,
                ctx.accounts.mint.decimals,
            )?;
        }

        Ok(())
    }

    pub fn unstake(ctx: Context<Unstake>) -> Result<()> {
        let position = &ctx.accounts.position;
        let pool = &mut ctx.accounts.pool;
        let clock = Clock::get()?;

        let current_state = get_market_state(&ctx.accounts.market_status)?;
        let trading_day_index = get_trading_day_index(&ctx.accounts.market_status)?;

        let gross_rewards =
            calculate_rewards(position, pool, clock.unix_timestamp, trading_day_index);

        let penalty = if current_state != 1 {
            gross_rewards * pool.penalty_bps as u64 / 10000
        } else {
            0
        };

        let net_rewards = gross_rewards.saturating_sub(penalty);
        let posr_tax = net_rewards * pool.posr_tax_bps as u64 / 10000;
        let user_rewards = net_rewards.saturating_sub(posr_tax);

        pool.total_staked -= position.amount;

        let pool_bump = pool.bump;
        let pool_mint = pool.mint;
        let signer_seeds: &[&[&[u8]]] = &[&[b"pool", pool_mint.as_ref(), &[pool_bump]]];

        // Return principal
        let cpi = TransferChecked {
            from: ctx.accounts.vault.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.owner_token.to_account_info(),
            authority: pool.to_account_info(),
        };
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi,
                signer_seeds,
            ),
            position.amount,
            ctx.accounts.mint.decimals,
        )?;

        // Pay net rewards
        if user_rewards > 0 {
            let cpi = TransferChecked {
                from: ctx.accounts.reward_vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.owner_token.to_account_info(),
                authority: pool.to_account_info(),
            };
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi,
                    signer_seeds,
                ),
                user_rewards,
                ctx.accounts.mint.decimals,
            )?;
        }

        // POSR tax
        if posr_tax > 0 {
            let cpi = TransferChecked {
                from: ctx.accounts.reward_vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.posr_vault.to_account_info(),
                authority: pool.to_account_info(),
            };
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi,
                    signer_seeds,
                ),
                posr_tax,
                ctx.accounts.mint.decimals,
            )?;
        }

        Ok(())
    }
}

// --- Raw byte helpers for cross-program market status ---

fn get_market_state(market_status: &AccountInfo) -> Result<u8> {
    let data = market_status.try_borrow_data()?;
    require!(data.len() >= 9, StakeError::InvalidMarketStatus);
    Ok(data[8])
}

fn get_trading_day_index(market_status: &AccountInfo) -> Result<u64> {
    let data = market_status.try_borrow_data()?;
    require!(data.len() >= 25, StakeError::InvalidMarketStatus);
    // Layout: 8 byte disc + 1 byte state + 8 byte timestamp + 8 byte index
    Ok(u64::from_le_bytes(data[17..25].try_into().unwrap()))
}

// --- Math ---

fn calculate_rewards(
    position: &StakePosition,
    pool: &StakePool,
    now: i64,
    current_trading_day: u64,
) -> u64 {
    let elapsed = (now - position.last_claim_timestamp) as u64;
    if elapsed == 0 || position.amount == 0 {
        return 0;
    }

    let trading_days = current_trading_day
        .saturating_sub(position.entry_trading_day)
        .saturating_sub(1);
    let mult = calculate_multiplier(trading_days, pool.max_multiplier_bps);

    let annual_secs: u64 = 31_536_000;
    let amount = position.amount as u128;
    let apy = pool.base_apy_bps as u128;
    let m = mult as u128;
    let e = elapsed as u128;

    let num = amount * apy * m * e;
    let den = 10_000u128 * 10_000u128 * annual_secs as u128;

    (num / den) as u64
}

fn calculate_multiplier(trading_days: u64, max_bps: u16) -> u64 {
    let base = 10_000u64;
    let max = max_bps as u64;
    let range = max.saturating_sub(base);
    let num = trading_days * range;
    let den = trading_days + 60;
    base + (num / den)
}

// --- Types ---

#[account]
pub struct StakePool {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub reward_vault: Pubkey,
    pub posr_vault: Pubkey,
    pub total_staked: u64,
    pub base_apy_bps: u16,
    pub max_multiplier_bps: u16,
    pub penalty_bps: u16,
    pub posr_tax_bps: u16,
    pub market_status_pda: Pubkey,
    pub bump: u8,
}

#[account]
pub struct StakePosition {
    pub owner: Pubkey,
    pub pool: Pubkey,
    pub amount: u64,
    pub entry_trading_day: u64,
    pub last_claim_timestamp: i64,
    pub index: u64,
    pub bump: u8,
}

#[account]
pub struct UserStakeIndex {
    pub next_index: u64,
}

// --- Accounts ---

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = authority,
        seeds = [b"pool", mint.key().as_ref()],
        bump,
        space = 8 + 256
    )]
    pub pool: Account<'info, StakePool>,
    #[account(
        init,
        payer = authority,
        seeds = [b"vault", pool.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pool,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = authority,
        seeds = [b"rewards", pool.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pool,
    )]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = authority,
        seeds = [b"posr", pool.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pool,
    )]
    pub posr_vault: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: Crank oracle market status PDA
    pub market_status_pda: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositRewards<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, has_one = authority, has_one = mint)]
    pub pool: Account<'info, StakePool>,
    #[account(mut, token::mint = mint, token::authority = pool)]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = authority)]
    pub authority_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(index: u64)]
pub struct Stake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub pool: Account<'info, StakePool>,
    #[account(
        init_if_needed,
        payer = owner,
        seeds = [b"user_index", owner.key().as_ref()],
        bump,
        space = 8 + 8
    )]
    pub user_index: Account<'info, UserStakeIndex>,
    #[account(
        init,
        payer = owner,
        seeds = [
            b"position",
            pool.key().as_ref(),
            owner.key().as_ref(),
            &index.to_le_bytes(),
        ],
        bump,
        space = 8 + 128
    )]
    pub position: Account<'info, StakePosition>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub owner_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = pool)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: Crank oracle market status PDA (raw bytes)
    #[account(address = pool.market_status_pda)]
    pub market_status: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, has_one = mint)]
    pub pool: Account<'info, StakePool>,
    #[account(mut, has_one = owner, has_one = pool)]
    pub position: Account<'info, StakePosition>,
    #[account(mut, token::mint = mint, token::authority = pool)]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = pool)]
    pub posr_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub owner_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: Crank oracle market status PDA (raw bytes)
    #[account(address = pool.market_status_pda)]
    pub market_status: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, has_one = mint)]
    pub pool: Account<'info, StakePool>,
    #[account(mut, has_one = owner, has_one = pool, close = owner)]
    pub position: Account<'info, StakePosition>,
    #[account(mut, token::mint = mint, token::authority = pool)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = pool)]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = pool)]
    pub posr_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub owner_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: Crank oracle market status PDA (raw bytes)
    #[account(address = pool.market_status_pda)]
    pub market_status: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[error_code]
pub enum StakeError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Stake amount below minimum")]
    MinStake,
    #[msg("No rewards to claim")]
    NoRewards,
    #[msg("Invalid market status account")]
    InvalidMarketStatus,
}
