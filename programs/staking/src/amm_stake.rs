use anchor_lang::prelude::*;
pub fn create_amm_position(
    ctx: Context<CreateAmmPosition>,
    amount: u64,
    entry_day: u64,
    vesting_days: u8,
    discount_bps: u16,
    cost_basis: u64,
) -> Result<()> {
    // Only callable via CPI from authorized AMM program
    require!(
        ctx.accounts.amm_program.key() == AUTHORIZED_AMM_PROGRAM,
        StakeError::UnauthorizedAmm
    );

    let position = &mut ctx.accounts.position;
    position.owner = ctx.accounts.owner.key();
    position.amount = amount;
    position.entry_trading_day = entry_day;
    position.position_type = PositionType::AmmDiscountedStake;
    position.vesting_unlock_day = entry_day + vesting_days as u64;
    position.discount_bps = discount_bps;
    position.original_cost_basis = cost_basis;

    // Weight starts at 0 until vesting completes — this is key!
    // Or, weight accrues but claims are blocked until vesting_unlock_day
    position.current_weight = 0; // No rewards until vested
    position.reward_debt = 0;

    Ok(())
}
pub use create_amm_position;
