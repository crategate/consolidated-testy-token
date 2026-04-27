use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_fee_set, Mint, TokenInterface, TransferFeeSetTransferFee,
};
use switchboard_on_demand::prelude::rust_decimal::prelude::ToPrimitive;
use switchboard_on_demand::{default_queue, SwitchboardQuote, SwitchboardQuoteExt};

declare_id!("EqA8JFvh2XkxQNLohZ4gJprWSv6z897BsjfBhnQDoDPZ");

/// Basic Oracle Example Program
///
/// This program demonstrates the simplest possible integration with
/// Switchboard's managed update system. Perfect for learning and
/// simple applications.
#[program]
pub mod crank_oracle {
    use anchor_spl::token_2022::spl_token_2022::extension::transfer_fee;

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

        // calculate zeh fee....
        let fee_bps: u16 = match ctx.accounts.market_status.current_state {
            0 => 0,   // 0%
            1 => 100, // 1.0%
            2 => 250, // 2.5%
            3 => 800, // 8.0%
            _ => 0,
        };

        msg!(
            "Market state is {}. Setting transfer fee to {} bps.",
            ctx.accounts.market_status.current_state,
            fee_bps
        );
        // 2. Prepare the CPI accounts
        let cpi_accounts = TransferFeeSetTransferFee {
            token_program_id: ctx.accounts.token_program.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            authority: ctx.accounts.fee_authority.to_account_info(),
        };

        let cpi_program = ctx.accounts.token_program.to_account_info();

        // 3. Prepare the PDA signature (The "Corporate Stamp")
        let bump = ctx.bumps.fee_authority;
        let signer_seeds: &[&[&[u8]]] = &[&[b"fee_authority", &[bump]]];

        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

        // 4. Fire the CPI
        // The second parameter is the new fee. The third parameter is the max fee.
        // (You usually just pass the same fee_bps or your hardcoded 800 max).
        transfer_fee_set(cpi_ctx, fee_bps, 900)?;
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

    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,

    /// CHECK: The PDA we derived in TypeScript. Anchor will automatically
    /// verify the seeds because we defined them here.
    #[account(
        seeds = [b"fee_authority"],
        bump
    )]
    pub fee_authority: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
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
