use crate::state::offersState::AmmState;
use anchor_lang::prelude::*;

// Pin the Raydium SOL/USDC CPMM pool used to convert SOL bond payments to USDC
// at claim time (All-USDC route). authority || keeper.
#[derive(Accounts)]
pub struct SetSolUsdcPool<'info> {
    pub cranker: Signer<'info>,
    #[account(
        mut,
        seeds = [b"amm_state", amm_state.afho_mint.as_ref()],
        bump = amm_state.bump,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,
}

pub fn handler(ctx: Context<SetSolUsdcPool>, pool_state: Pubkey, amm_config: Pubkey) -> Result<()> {
    let caller = ctx.accounts.cranker.key();
    require!(
        caller == ctx.accounts.amm_state.authority || caller == ctx.accounts.amm_state.keeper,
        ErrorCode::UnauthorizedCaller
    );
    ctx.accounts.amm_state.cpmm_sol_usdc_pool = pool_state;
    ctx.accounts.amm_state.cpmm_sol_usdc_config = amm_config;
    msg!("SOL/USDC pool pinned: pool {} amm_config {}", pool_state, amm_config);
    Ok(())
}

#[error_code]
pub enum ErrorCode {
    #[msg("Unauthorized caller")]
    UnauthorizedCaller,
}
