use anchor_lang::prelude::*;
use switchboard_on_demand::prelude::rust_decimal::prelude::ToPrimitive;
use switchboard_on_demand::{default_queue, SwitchboardQuote, SwitchboardQuoteExt};

declare_id!("B692MbcR2C84pQrYW4iyJWfQ482UM2s87KZSHAjShKsc");

/// Basic Oracle Example Program
///
/// This program demonstrates the simplest possible integration with
/// Switchboard's managed update system. Perfect for learning and
/// simple applications.
#[program]
pub mod crank_oracle {
    use super::*;

    /// Read and verify oracle data from the managed oracle account
    ///
    /// This is the simplest way to consume Switchboard oracle data.
    /// The oracle account is derived canonically from feed hashes and
    /// updated by the quote program's verified_update instruction.
    ///
    /// ## Usage
    /// 1. Call fetchManagedUpdateIxs to update the oracle account
    /// 2. Call this instruction to read the verified data
    ///
    /// ## Parameters
    /// - quote_account: The canonical oracle account (derived from feed hashes)
    /// - queue: The Switchboard queue (auto-detected by network)
    /// - sysvars: Required system variables for verification
    pub fn read_oracle_data(ctx: Context<ReadOracleData>) -> Result<()> {
        // Access the oracle data directly
        // The quote_account constraint validates it's the canonical account
        let feeds = &ctx.accounts.quote_account.feeds;

        // Calculate staleness
        let current_slot = ctx.accounts.sysvars.clock.slot;
        let quote_slot = ctx.accounts.quote_account.slot;
        let staleness = current_slot.saturating_sub(quote_slot);

        msg!("Number of feeds: {}", feeds.len());
        msg!(
            "📅 Quote slot: {}, Current slot: {}",
            quote_slot,
            current_slot
        );
        msg!("⏰ Staleness: {} slots", staleness);

        // Process each feed
        for (i, feed) in feeds.iter().enumerate() {
            msg!("📊 Feed {}: ID = {}", i, feed.hex_id());
            msg!("💰 Feed {}: Value = {}", i, feed.value());

            // - Store the price in your program state
            // - Trigger events based on price changes
            // - Use the price for calculations
        }

        msg!("✅ Successfully read {} oracle feeds!", feeds.len());

        msg!("WRITING TO pda STATE ACCOUNT");
        ctx.accounts.market_status.current_state = feeds[0]
            .value()
            .to_u8()
            .expect("number unable to convert to u8!!");
        ctx.accounts.market_status.last_updated_timestamp = Clock::get()?.unix_timestamp;
        Ok(())
    }
    pub fn initialize_state(ctx: Context<InitializeState>) -> Result<()> {
        let state = &mut ctx.accounts.market_status;

        state.current_state = 99;
        Ok(())
    }
}

/// Account context for reading oracle data
///
/// This is designed to be as simple as possible while still being secure.
/// The quote_account is the canonical account derived from feed hashes.
#[derive(Accounts)]
pub struct ReadOracleData<'info> {
    /// The canonical oracle account containing verified quote data
    ///
    /// This account is:
    /// - Updated by the quote program's verified_update instruction
    /// - Contains verified oracle data
    /// - Validated to be the canonical account for the contained feeds
    #[account(address = quote_account.canonical_key(&default_queue()))]
    pub quote_account: Box<Account<'info, SwitchboardQuote>>,

    /// System variables required for quote verification
    pub sysvars: Sysvars<'info>,

    #[account(mut)]
    pub market_status: Account<'info, MarketStatus>,
}

#[account]
pub struct MarketStatus {
    pub current_state: u8,
    pub last_updated_timestamp: i64,
}

#[derive(Accounts)]
pub struct InitializeState<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + 8 + 8,
        seeds = [b"market_status"],
        bump,
    )]
    pub market_status: Account<'info, MarketStatus>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}
/// System variables required for oracle verification
#[derive(Accounts)]
pub struct Sysvars<'info> {
    pub clock: Sysvar<'info, Clock>,
}
