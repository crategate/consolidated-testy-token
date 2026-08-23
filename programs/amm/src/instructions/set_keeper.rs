use crate::state::offersState::AmmState;
use anchor_lang::prelude::*;

// Rotate the hot keeper wallet allowed to fire crank-gated daily instructions.
// Authority-only; the keeper itself can never call this.
#[derive(Accounts)]
pub struct SetKeeper<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"amm_state", amm_state.afho_mint.as_ref()],
        bump = amm_state.bump,
        has_one = authority,
    )]
    pub amm_state: Account<'info, AmmState>,
}

pub fn handler(ctx: Context<SetKeeper>, new_keeper: Pubkey) -> Result<()> {
    ctx.accounts.amm_state.keeper = new_keeper;
    msg!("keeper rotated to {}", new_keeper);
    Ok(())
}