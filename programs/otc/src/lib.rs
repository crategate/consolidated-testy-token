use anchor_lang::prelude::*;

declare_id!("D4ykpxBETNEpioCtUMLh8VoRmbokANPx9pEg4v3GkQms");

#[program]
pub mod otc {
    use super::*;

    pub fn initialize(ctx: Context<Offers>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Offers<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
}
