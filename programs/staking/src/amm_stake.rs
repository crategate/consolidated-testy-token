use crate::{
    calculate_multiplier, get_trading_day_index, Stake, StakeError, StakePool, StakePosition,
    UserStakeIndex,
};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

pub fn create_amm_position(
    ctx: Context<CreateAmmPosition>,
    amount: u64,
    index: u64,
    days: u8,
) -> Result<()> {
    // Only callable via CPI from authorized AMM program
    let amm_program_id = ctx.accounts.pool.amm_program;
    require!(
        ctx.accounts.amm_program.key() == amm_program_id,
        CpiError::UnauthorizedAmm
    );
    require!(
        ctx.accounts.amm_program.is_signer,
        CpiError::UnauthorizedAmm
    );

    require!(amount > 0, StakeError::ZeroAmount);
    require!(amount >= 100, StakeError::MinStake);
    require!(days > 0, CpiError::InvalidVestingPeriod); // AMM positions MUST vest
                                                        //
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
    position.days_to_unlock = days;
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

// mainnet release: remove before launch
pub fn update_amm_program(ctx: Context<UpdateAmmProgram>, new_amm_program: Pubkey) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    pool.amm_program = new_amm_program;
    msg!("Updated AMM program to: {}", new_amm_program);
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateAmmProgram<'info> {
    #[account(mut, has_one = authority)]
    pub pool: Account<'info, StakePool>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(amount: u64, index: u64, days: u8)]
pub struct CreateAmmPosition<'info> {
    /// CHECK: Verified below against authorized AMM program ID
    #[account(mut)]
    pub amm_program: AccountInfo<'info>,

    #[account(mut)]
    pub owner: Signer<'info>, // The buyer (ultimately receives the position)

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub pool: Account<'info, StakePool>,

    #[account(
        init_if_needed,
        payer = amm_program,  // AMM pays for user_index creation
        seeds = [b"user_index", owner.key().as_ref()],
        bump,
        space = 8 + 8
    )]
    pub user_index: Account<'info, UserStakeIndex>,

    #[account(
        init,
        payer = amm_program,  // AMM pays for position creation
        seeds = [
            b"position",
            pool.key().as_ref(),
            owner.key().as_ref(),
            &index.to_le_bytes(),
        ],
        bump,
        space = 8 + 160  // Adjust for new fields
    )]
    pub position: Account<'info, StakePosition>,

    /// Where the NYSEH tokens come from (AMM's escrow/ATA, not buyer's wallet)
    #[account(mut, token::mint = mint, token::authority = amm_program)]
    pub source_token: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::mint = mint, token::authority = pool)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Address verified by pool.market_status_pda constraint
    #[account(address = pool.market_status_pda)]
    pub market_status: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
#[error_code]
pub enum CpiError {
    #[msg("unauthorized vested amm stake...")]
    UnauthorizedAmm,
    #[msg("positions must vest for at least 1 trading day")]
    InvalidVestingPeriod,
}
