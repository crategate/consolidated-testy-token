use anchor_lang::prelude::*;

declare_id!("D4ykpxBETNEpioCtUMLh8VoRmbokANPx9pEg4v3GkQms");

#[program]
pub mod otc {
    use super::*;

    pub fn initialize(ctx: Context<OffersLists>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
    pub fn tonights_offers(ctx: Context<TonightsOffers>) -> Result<()> {
        // analyze market performance
        //
        // determine offers available
        // no more than 5% of total POSR
        //
        // build offer list & write to account
        Ok(())
    }

    pub fn offer_claim(ctx: Context<OfferClaim>, amount: u8) -> Result<()> {
        // decrease # of offers available by amount
        // multiply amount * market price * discount
        // create locked stake position for user
        Ok(())
    }

    pub fn dex_buyback() -> Result<()> {
        Ok(())
    }
}

#[account]
pub struct Offer {
    pub lotSize: u8,     // size in total, whole NYSEH tokens, 50, 100, 500, 1000, 5k, 10k
    pub vestingDays: u8, // how many trading days to unlock
    pub discount: u8,    // % bps discount from live DEX prices
    pub index: u64,
}

#[derive(Accounts)]
pub struct TonightsOffers<'info> {
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut)]
    pub offer_list: Box<Account<'info, offersList>>,
}
#[derive(Accounts)]
pub struct OfferClaim<'info> {
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub owner: Signer<'info>,
}
