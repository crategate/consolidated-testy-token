use anchor_lang::prelude::*;
use switchboard_on_demand::prelude::rust_decimal::prelude::ToPrimitive;
use switchboard_on_demand::{default_queue, SwitchboardQuote, SwitchboardQuoteExt};

declare_id!("5BkqMghT4iAWbfJyNhJ5oSYBoAfBMD1SvHKtxMxzssRF");

#[error_code]
pub enum CrankError {
    #[msg("No feeds found in oracle quote")]
    NoFeeds,
    #[msg("Feed value could not be converted to u8")]
    InvalidFeedValue,
}

#[program]
pub mod crank_oracle {
    use super::*;

    pub fn read_oracle_data(ctx: Context<ReadOracleData>) -> Result<()> {
        let feeds = &ctx.accounts.quote_account.feeds;
        require!(!feeds.is_empty(), CrankError::NoFeeds);

        let current_slot = ctx.accounts.clock.slot;
        let quote_slot = ctx.accounts.quote_account.slot;
        let staleness = current_slot.saturating_sub(quote_slot);

        msg!(
            "Feeds: {} | Quote slot: {} | Staleness: {}",
            feeds.len(),
            quote_slot,
            staleness
        );

        let new_state = feeds[0]
            .value()
            .to_u8()
            .ok_or(CrankError::InvalidFeedValue)?;

        let market_status = &mut ctx.accounts.market_status;
        let old_state = market_status.current_state;

        // Increment trading day counter when the market closes
        if (old_state == 1 || old_state == 2) && new_state == 0 {
            market_status.trading_day_index =
                market_status.trading_day_index.checked_add(1).unwrap();
            msg!(
                "Market closed. Trading day index: {}",
                market_status.trading_day_index
            );
        }

        market_status.current_state = new_state;
        market_status.last_updated_timestamp = Clock::get()?.unix_timestamp;

        msg!(
            "Market state: {} | Timestamp: {}",
            new_state,
            market_status.last_updated_timestamp
        );
        Ok(())
    }

    pub fn initialize_state(ctx: Context<InitializeState>) -> Result<()> {
        let state = &mut ctx.accounts.market_status;
        state.current_state = 99;
        state.trading_day_index = 0;
        state.last_updated_timestamp = 0;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct ReadOracleData<'info> {
    #[account(address = quote_account.canonical_key(&default_queue()))]
    pub quote_account: Box<Account<'info, SwitchboardQuote>>,
    pub clock: Sysvar<'info, Clock>,
    #[account(mut)]
    pub market_status: Account<'info, MarketStatus>,
}

#[account]
pub struct MarketStatus {
    pub current_state: u8, // 0=closed, 1=open, 2=extended, 3=halted
    pub last_updated_timestamp: i64,
    pub trading_day_index: u64, // Increments on every market close
}

#[derive(Accounts)]
pub struct InitializeState<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + 32, // disc + aligned struct
        seeds = [b"market_status"],
        bump,
    )]
    pub market_status: Account<'info, MarketStatus>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}
