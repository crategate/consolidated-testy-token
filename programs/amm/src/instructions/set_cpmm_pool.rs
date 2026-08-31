use crate::state::offersState::AmmState;
use anchor_lang::prelude::*;

// Pin the Raydium CPMM pool the swap adapter routes through. authority || keeper
// (same gate as the other crank-fired instructions); the pool only becomes real
// at launch, so this is set after the one-off createPool.
#[derive(Accounts)]
pub struct SetCpmmPool<'info> {
    pub cranker: Signer<'info>,
    #[account(
        mut,
        seeds = [b"amm_state", amm_state.afho_mint.as_ref()],
        bump = amm_state.bump,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,
}

pub fn handler(
    ctx: Context<SetCpmmPool>,
    cpmm_program: Pubkey,
    pool_state: Pubkey,
    amm_config: Pubkey,
) -> Result<()> {
    let caller = ctx.accounts.cranker.key();
    // Authority-only: pool pinning decides where every swap routes, so the
    // hot-wallet keeper must not be able to re-pin it to a pool it controls.
    require!(
        caller == ctx.accounts.amm_state.authority,
        ErrorCode::UnauthorizedCaller
    );
    ctx.accounts.amm_state.cpmm_program = cpmm_program;
    ctx.accounts.amm_state.cpmm_pool_state = pool_state;
    ctx.accounts.amm_state.cpmm_amm_config = amm_config;
    msg!(
        "CPMM pool pinned: program {} pool {} amm_config {}",
        cpmm_program,
        pool_state,
        amm_config
    );
    Ok(())
}

#[error_code]
pub enum ErrorCode {
    #[msg("Unauthorized caller")]
    UnauthorizedCaller,
}
