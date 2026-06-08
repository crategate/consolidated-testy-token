use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

// =============================================================================
// NYSEH STAKING PROGRAM — COMPLETE IMPLEMENTATION
// =============================================================================
//
// ARCHITECTURE OVERVIEW
// ---------------------
// This program manages a SINGLE global staking pool per token mint. All users
// stake into this pool. The pool tracks aggregate state and owns vault accounts
// that hold everyone's funds.
//
// REWARD MODEL: Pure Multiplier-Weighted Distribution (No Time-Based Yield)
// ------------------------------------------------------------------------
// There is NO automatic yield accrual over time. Rewards come exclusively from:
//   1. Penalties paid by users who claim during non-market-open hours
//   2. External deposits (AMM revenue)
//
// The multiplier (1.0x → 3.0x logarithmic) determines your SHARE of rewards.
// Longer lock = higher multiplier = bigger slice of the penalty/AMM pie.
//
// MASTERCHEF DISTRIBUTION (O(1) per user, no iteration needed):
//   - Global index: accrued_reward_per_share (scaled by 1e12)
//   - User debt:    reward_debt (scaled by 1e12) — prevents double-claiming
//   - User claim:   (user_weight * global_index / 1e12) - user_debt
//   - New debt set:  user_weight * global_index / 1e12
//
// WEIGHT CALCULATION:
//   weight = staked_amount * multiplier / 10_000
//   multiplier = 10_000 + (trading_days * (max_multiplier - 10_000)) / (trading_days + 60)
//
// PENALTY TIERS (applied when claiming/unstaking during non-open hours):
//   - State 0 (Open):      0 bps — no penalty
//   - State 1 (After):     configurable (e.g., 500 = 5%)
//   - State 2 (Closed):    configurable (e.g., 1500 = 15%)
//   - State 3 (Halted):    configurable (e.g., 3000 = 30%)
//
// POSR TAX: 5% on all claims and unstakes → goes to protocol-owned reserve
//
// USER STORIES
// ------------
// [Alice stakes 1000 NYSEH on Day 5, market open]
//   → stake() creates position with entry_trading_day=5, amount=1000
//   → weight = 1000 * 1.0x = 1000 (multiplier starts at base)
//   → tokens move from Alice's wallet → pool vault
//   → pool.total_staked += 1000, pool.total_weighted_stake += 1000
//
// [10 days later, Alice claims, market is open]
//   → claim() reads state=0, penalty_bps=0
//   → trading_days = 15 - 5 - 1 = 9, multiplier ≈ 1.3x
//   → weight = 1000 * 1.3x = 1300
//   → penalty_share = (1300 * global_index / 1e12) - debt
//   → penalty = 0 (market open), posr_tax = 5% of penalty_share
//   → Alice receives 95% of penalty_share
//
// [Bob unstakes during after-hours (state 1)]
//   → unstake() reads state=1, penalty_bps=500 (5%)
//   → Bob's penalty_share calculated from his weight
//   → 5% of penalty_share → penalty_vault (for future distribution)
//   → 95% of remainder → Bob (after another 5% POSR tax)
//   → principal returned, position account closed
//
// [Market opens next day — penalties distribute]
//   → tokens move from penalty_vault → reward_vault
//   → global_index += (penalty_amount * 1e12) / total_weighted_stake
//   → Alice's next claim includes her share of Bob's penalty
// =============================================================================

declare_id!("JKHegwqjrDuFfQ2msscavMZJ1cok7D6to1SwkcPvxhj");

#[program]
pub mod staking {
    use super::*;

    // -------------------------------------------------------------------------
    // INITIALIZE POOL
    // Called ONCE by protocol admin. Creates the global pool and all vaults.
    // -------------------------------------------------------------------------
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        crank_oracle_program_id: Pubkey,
        max_multiplier_bps: u16, // Cap for multiplier (e.g., 30000 = 3.0x)
        posr_tax_bps: u16,       // Tax on claims/unstakes (e.g., 500 = 5%)
        after_hours_penalty_bps: u16, // Penalty: state 1 (after hours)
        closed_penalty_bps: u16, // Penalty: state 2 (market closed)
        halted_penalty_bps: u16, // Penalty: state 3 (trading halted)
    ) -> Result<()> {
        // SECURITY: Verify the passed market_status_pda matches what the crank
        // oracle program would derive. Prevents initializing with a fake oracle.
        let (expected_pda, _) =
            Pubkey::find_program_address(&[b"market_status"], &crank_oracle_program_id);
        require!(
            expected_pda == ctx.accounts.market_status_pda.key(),
            StakeError::InvalidMarketStatus
        );

        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.authority.key();
        pool.mint = ctx.accounts.mint.key();
        pool.vault = ctx.accounts.vault.key();
        pool.reward_vault = ctx.accounts.reward_vault.key();
        pool.penalty_vault = ctx.accounts.penalty_vault.key();
        pool.posr_vault = ctx.accounts.posr_vault.key();
        pool.total_staked = 0;
        pool.total_weighted_stake = 0;
        pool.max_multiplier_bps = max_multiplier_bps;
        pool.posr_tax_bps = posr_tax_bps;
        pool.after_hours_penalty_bps = after_hours_penalty_bps;
        pool.closed_penalty_bps = closed_penalty_bps;
        pool.halted_penalty_bps = halted_penalty_bps;
        pool.accrued_reward_per_share = 0;
        pool.market_status_pda = ctx.accounts.market_status_pda.key();
        pool.bump = ctx.bumps.pool;

        msg!("Pool initialized for mint {}", pool.mint);
        msg!(
            "Max multiplier: {} bps, POSR tax: {} bps",
            max_multiplier_bps,
            posr_tax_bps
        );
        Ok(())
    }

    // -------------------------------------------------------------------------
    // DEPOSIT REWARDS
    // Called by admin or external programs (AMM) to seed reward_vault.
    // These tokens become distributable via the MasterChef index.
    // -------------------------------------------------------------------------
    pub fn deposit_rewards(ctx: Context<DepositRewards>, amount: u64) -> Result<()> {
        require!(amount > 0, StakeError::ZeroAmount);

        // SECURITY: Only pool authority can deposit rewards
        // (enforced by has_one = authority on pool account)

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.authority_token.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.reward_vault.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)
    }

    // -------------------------------------------------------------------------
    // STAKE
    // Called by user to lock tokens. Creates a new StakePosition PDA.
    // Each stake transaction creates a separate position (index 0, 1, 2...).
    // -------------------------------------------------------------------------
    pub fn stake(ctx: Context<Stake>, amount: u64, index: u64) -> Result<()> {
        require!(amount > 0, StakeError::ZeroAmount);
        require!(amount >= 100, StakeError::MinStake);

        let pool = &mut ctx.accounts.pool;
        let position = &mut ctx.accounts.position;
        let user_index = &mut ctx.accounts.user_index;
        let clock = Clock::get()?;

        let trading_day_index = get_trading_day_index(&ctx.accounts.market_status)?;

        // Initialize position
        position.owner = ctx.accounts.owner.key();
        position.pool = pool.key();
        position.amount = amount;
        position.entry_trading_day = trading_day_index;
        position.last_claim_timestamp = clock.unix_timestamp;
        position.index = index;
        position.bump = ctx.bumps.position;

        // Update user's next available index
        user_index.next_index = user_index.next_index.max(index + 1);

        // Calculate initial weight (multiplier = 1.0x on day 0)
        let current_multiplier = calculate_multiplier(0, pool.max_multiplier_bps);
        let weight = (amount as u128 * current_multiplier as u128) / 10_000u128;
        position.current_weight = weight;

        // Update pool aggregates
        pool.total_staked = pool.total_staked.saturating_add(amount);
        pool.total_weighted_stake = pool.total_weighted_stake.saturating_add(weight);

        // Set reward debt so user doesn't claim past distributions
        position.reward_debt = (weight * pool.accrued_reward_per_share) / 1_000_000_000_000u128;

        // Transfer tokens from user to pool vault
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.owner_token.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.owner.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;

        msg!(
            "Staked {} tokens, weight: {}, index: {}",
            amount,
            weight,
            index
        );
        Ok(())
    }

    // -------------------------------------------------------------------------
    // CLAIM
    // Called by user to collect rewards WITHOUT unstaking principal.
    // Rewards = penalty_share - penalty - posr_tax.
    // If market is NOT open, a tiered penalty is applied to the reward share.
    // -------------------------------------------------------------------------
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let position = &mut ctx.accounts.position;
        let pool = &mut ctx.accounts.pool;
        let clock = Clock::get()?;

        let trading_day_index = get_trading_day_index(&ctx.accounts.market_status)?;
        let current_state = get_market_state(&ctx.accounts.market_status)?;
        require!(current_state == 0, StakeError::ClaimsClosed);

        // Settle rewards at the last applied weight so a multiplier increase
        // only affects future reward distributions.
        let old_weight = position.current_weight;
        let accumulated = (old_weight * pool.accrued_reward_per_share) / 1_000_000_000_000u128;
        let penalty_share = accumulated.saturating_sub(position.reward_debt);

        // Refresh the stored weight after settling existing rewards.
        let trading_days = trading_day_index
            .saturating_sub(position.entry_trading_day)
            .saturating_sub(1);
        let current_multiplier = calculate_multiplier(trading_days, pool.max_multiplier_bps);
        let new_weight = (position.amount as u128 * current_multiplier as u128) / 10_000u128;

        if new_weight > old_weight {
            pool.total_weighted_stake = pool
                .total_weighted_stake
                .saturating_add(new_weight.saturating_sub(old_weight));
        } else if old_weight > new_weight {
            pool.total_weighted_stake = pool
                .total_weighted_stake
                .saturating_sub(old_weight.saturating_sub(new_weight));
        }
        position.current_weight = new_weight;
        position.reward_debt = (new_weight * pool.accrued_reward_per_share) / 1_000_000_000_000u128;

        // Apply POSR tax (e.g., 5%). Tiered claim penalties are disabled
        // because claims are only allowed while the market is open.
        let posr_tax = penalty_share * pool.posr_tax_bps as u128 / 10_000u128;
        let user_rewards = penalty_share.saturating_sub(posr_tax);

        let signer_seeds: &[&[&[u8]]] = &[&[b"pool", pool.mint.as_ref(), &[pool.bump]]];

        // Send POSR tax to posr_vault
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
                posr_tax as u64,
                ctx.accounts.mint.decimals,
            )?;
        }

        // Send net rewards to user
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
                user_rewards as u64,
                ctx.accounts.mint.decimals,
            )?;
        }

        position.last_claim_timestamp = clock.unix_timestamp;
        msg!("Claimed: {} (posr: {})", user_rewards, posr_tax);
        Ok(())
    }

    // -------------------------------------------------------------------------
    // UNSTAKE
    // Called by user to exit completely. Returns principal + net rewards.
    // Position account is closed (rent refunded to user).
    // -------------------------------------------------------------------------
    pub fn unstake(ctx: Context<Unstake>) -> Result<()> {
        let position = &ctx.accounts.position;
        let pool = &mut ctx.accounts.pool;
        let current_state = get_market_state(&ctx.accounts.market_status)?;
        let trading_day_index = get_trading_day_index(&ctx.accounts.market_status)?;

        // Settle pending rewards at the position's last applied weight.
        let old_weight = position.current_weight;
        let accumulated = (old_weight * pool.accrued_reward_per_share) / 1_000_000_000_000u128;
        let penalty_share = accumulated.saturating_sub(position.reward_debt);

        // Calculate current multiplier for logging/accounting context. The pool
        // only contains the last applied weight, so removal subtracts old_weight.
        let trading_days = trading_day_index
            .saturating_sub(position.entry_trading_day)
            .saturating_sub(1);
        let current_multiplier = calculate_multiplier(trading_days, pool.max_multiplier_bps);
        let _current_weight = (position.amount as u128 * current_multiplier as u128) / 10_000u128;

        // POSR tax still applies to earned rewards; tiered exit penalties
        // apply to principal only.
        let reward_posr_tax = penalty_share * pool.posr_tax_bps as u128 / 10_000u128;
        let user_rewards = penalty_share.saturating_sub(reward_posr_tax);

        let principal_penalty_bps = get_principal_unstake_penalty_bps(current_state);
        let principal_penalty =
            position.amount as u128 * principal_penalty_bps as u128 / 10_000u128;
        let principal_to_user = (position.amount as u128).saturating_sub(principal_penalty);
        let principal_penalty_to_posr = principal_penalty * 500u128 / 10_000u128;
        let principal_penalty_to_rewards =
            principal_penalty.saturating_sub(principal_penalty_to_posr);

        // Update pool totals BEFORE closing position
        pool.total_staked = pool.total_staked.saturating_sub(position.amount);
        pool.total_weighted_stake = pool.total_weighted_stake.saturating_sub(old_weight);

        if principal_penalty_to_rewards > 0 && pool.total_weighted_stake > 0 {
            pool.accrued_reward_per_share +=
                (principal_penalty_to_rewards * 1_000_000_000_000u128) / pool.total_weighted_stake;
        }

        let pool_bump = pool.bump;
        let pool_mint = pool.mint;
        let signer_seeds: &[&[&[u8]]] = &[&[b"pool", pool_mint.as_ref(), &[pool_bump]]];

        // Return principal from vault
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
            principal_to_user as u64,
            ctx.accounts.mint.decimals,
        )?;

        // 95% of principal exit penalties becomes rewards for remaining stakers.
        if principal_penalty_to_rewards > 0 {
            let cpi = TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.reward_vault.to_account_info(),
                authority: pool.to_account_info(),
            };
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi,
                    signer_seeds,
                ),
                principal_penalty_to_rewards as u64,
                ctx.accounts.mint.decimals,
            )?;
        }

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
                user_rewards as u64,
                ctx.accounts.mint.decimals,
            )?;
        }

        // Reward POSR tax plus 5% of principal exit penalties goes to POSR.
        if reward_posr_tax > 0 {
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
                reward_posr_tax as u64,
                ctx.accounts.mint.decimals,
            )?;
        }

        if principal_penalty_to_posr > 0 {
            let cpi = TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
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
                principal_penalty_to_posr as u64,
                ctx.accounts.mint.decimals,
            )?;
        }

        // Position account auto-closed by Anchor (close = owner in accounts struct)
        msg!(
            "Unstaked: {} principal returned, {} rewards (principal penalty: {}, reward posr: {})",
            principal_to_user,
            user_rewards,
            principal_penalty,
            reward_posr_tax
        );
        Ok(())
    }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

fn get_principal_unstake_penalty_bps(current_state: u8) -> u64 {
    match current_state {
        1 => 300,  // extended hours
        2 => 700,  // market closed
        3 => 1800, // trading halted
        _ => 0,
    }
}

fn get_market_state(market_status: &AccountInfo) -> Result<u8> {
    let data = market_status.try_borrow_data()?;
    require!(data.len() >= 9, StakeError::InvalidMarketStatus);
    Ok(data[8])
}

fn get_trading_day_index(market_status: &AccountInfo) -> Result<u64> {
    let data = market_status.try_borrow_data()?;
    require!(data.len() >= 25, StakeError::InvalidMarketStatus);
    Ok(u64::from_le_bytes(data[17..25].try_into().unwrap()))
}

fn calculate_multiplier(trading_days: u64, max_bps: u16) -> u64 {
    let base = 10_000u64;
    let max = max_bps as u64;
    let range = max.saturating_sub(base);
    let num = trading_days * range;
    let den = trading_days + 60;
    base + (num / den)
}

// =============================================================================
// ACCOUNT STRUCTURES
// =============================================================================

#[account]
pub struct StakePool {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub reward_vault: Pubkey,
    pub penalty_vault: Pubkey,
    pub posr_vault: Pubkey,
    pub total_staked: u64,
    pub total_weighted_stake: u128,
    pub max_multiplier_bps: u16,
    pub posr_tax_bps: u16,
    pub after_hours_penalty_bps: u16,
    pub closed_penalty_bps: u16,
    pub halted_penalty_bps: u16,
    pub accrued_reward_per_share: u128,
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
    // Last applied reward weight. Multiplier growth is checkpointed here so
    // older reward distributions cannot be claimed again as weight grows.
    pub current_weight: u128,
    pub reward_debt: u128,
    pub bump: u8,
}

#[account]
pub struct UserStakeIndex {
    pub next_index: u64,
}

// =============================================================================
// ACCOUNTS CONTEXTS (Anchor validation & security constraints)
// =============================================================================

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
        space = 8 + 300
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
        seeds = [b"penalties", pool.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pool,
    )]
    pub penalty_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = authority,
        seeds = [b"posr", pool.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pool,
    )]
    pub posr_vault: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: Verified in instruction via find_program_address
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
#[instruction(amount: u64, index: u64)]
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
        space = 8 + 160
    )]
    pub position: Account<'info, StakePosition>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub owner_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = pool)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: Address verified by pool.market_status_pda constraint
    #[account(address = pool.market_status_pda)]
    pub market_status: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, has_one = mint)]
    pub pool: Box<Account<'info, StakePool>>,
    #[account(mut, has_one = owner, has_one = pool)]
    pub position: Box<Account<'info, StakePosition>>,
    #[account(mut, token::mint = mint, token::authority = pool)]
    pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = pool)]
    pub posr_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub owner_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: Address verified by pool.market_status_pda constraint
    #[account(address = pool.market_status_pda)]
    pub market_status: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, has_one = mint)]
    pub pool: Box<Account<'info, StakePool>>,
    #[account(mut, has_one = owner, has_one = pool, close = owner)]
    pub position: Box<Account<'info, StakePosition>>,
    #[account(mut, token::mint = mint, token::authority = pool)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = pool)]
    pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = pool)]
    pub penalty_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = pool)]
    pub posr_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub owner_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: Address verified by pool.market_status_pda constraint
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
    #[msg("Insufficient rewards in vault")]
    InsufficientRewards,
    #[msg("Claims are only available while the market is open")]
    ClaimsClosed,
}
