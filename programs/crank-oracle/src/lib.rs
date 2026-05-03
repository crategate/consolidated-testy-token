use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_fee_set, Mint, TokenInterface, TransferFeeSetTransferFee,
};
use switchboard_on_demand::prelude::rust_decimal::prelude::ToPrimitive;
use switchboard_on_demand::{default_queue, SwitchboardQuote, SwitchboardQuoteExt};

declare_id!("5BkqMghT4iAWbfJyNhJ5oSYBoAfBMD1SvHKtxMxzssRF");

/// Basic Oracle Example Program
///
/// This program demonstrates the simplest possible integration with
/// Switchboard's managed update system. Perfect for learning and
/// simple applications.

#[error_code]
pub enum CrankError {
    #[msg("No feeds found in oracle quote")]
    NoFeeds,
    #[msg("Feed value could not be converted to u8")]
    InvalidFeedValue,
    #[msg("Wrong authority payer key bounty_config")]
    InvalidAuthority,
    #[msg("Quote provided too stale")]
    QuoteTooStale,
    #[msg("Oracle quote is not newer than last crank")]
    StaleQuote,
    #[msg("Bounty vault is empty")]
    BountyExhausted,
}
#[program]
pub mod crank_oracle {
    use anchor_spl::token_2022::spl_token_2022::extension::transfer_fee;

    use super::*;
    pub fn initialize_bounty(ctx: Context<InitializeBounty>, bounty_amount: u64) -> Result<()> {
        ctx.accounts.bounty_config.set_inner(BountyConfig {
            authority: ctx.accounts.payer.key(),
            bounty_amount,
            last_crank_slot: 0,
            bump: ctx.bumps.bounty_config,
        });
        Ok(())
    }

    pub fn fund_bounty(ctx: Context<FundBounty>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.payer.key() == ctx.accounts.bounty_config.authority,
            CrankError::InvalidAuthority
        );
        // Transfer SOL into bounty_vault
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.payer.to_account_info(),
                to: ctx.accounts.bounty_vault.to_account_info(),
            },
        );
        system_program::transfer(cpi_ctx, amount)?;
        Ok(())
    }

    pub fn permissionless_crank(ctx: Context<PermissionlessCrank>) -> Result<()> {
        let quote_slot = ctx.accounts.quote_account.slot;
        let last_slot = ctx.accounts.bounty_config.last_crank_slot;
        let current_slot = ctx.accounts.clock.slot;
        let staleness = current_slot.saturating_sub(quote_slot);

        // During market hours, quotes must be < 10 minutes old (roughly 100 slots)
        // This forces keepers to crank frequently or the bounty becomes unclaimable
        let max_age = match ctx.accounts.market_status.current_state {
            0 | 1 => 100, // Open/Extended: 10 min max
            _ => 300,     // Closed/Halted: 30 min max
        };
        require!(staleness <= max_age, CrankError::QuoteTooStale);
        // Anti-spam: only pay if the oracle data is actually fresher
        require!(quote_slot > last_slot, CrankError::StaleQuote);

        // --- Your existing logic, extracted into a shared helper ---
        let market_state = ctx.accounts.quote_account.feeds[0]
            .value()
            .to_u8()
            .ok_or(CrankError::InvalidFeedValue)?;

        ctx.accounts.market_status.current_state = market_state;
        ctx.accounts.market_status.last_updated_timestamp = Clock::get()?.unix_timestamp;
        ctx.accounts.bounty_config.last_crank_slot = quote_slot;

        let fee_bps: u16 = match market_state {
            0 => 0,
            1 => 100,
            2 => 250,
            3 => 800,
            _ => 0,
        };

        // CPI to set mint fee
        let cpi_accounts = TransferFeeSetTransferFee {
            token_program_id: ctx.accounts.token_program.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            authority: ctx.accounts.fee_authority.to_account_info(),
        };
        let bump = ctx.bumps.fee_authority;
        let signer_seeds: &[&[&[u8]]] = &[&[b"fee_authority", &[bump]]];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        transfer_fee_set(cpi_ctx, fee_bps, 900)?;

        // --- Pay bounty ---
        let bounty = ctx.accounts.bounty_config.bounty_amount;
        require!(
            ctx.accounts.bounty_vault.lamports() >= bounty,
            CrankError::BountyExhausted
        );

        let vault_seeds: &[&[&[u8]]] = &[&[b"bounty_vault", &[ctx.bumps.bounty_vault]]];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.bounty_vault.to_account_info(),
                to: ctx.accounts.cranker.to_account_info(),
            },
            vault_seeds,
        );
        system_program::transfer(cpi_ctx, bounty)?;

        msg!(
            "Cranked by {}. Bounty paid: {} lamports",
            ctx.accounts.cranker.key(),
            bounty
        );
        Ok(())
    }
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
        require!(!feeds.is_empty(), CrankError::NoFeeds);

        // Calculate staleness
        let current_slot = ctx.accounts.clock.slot;
        let quote_slot = ctx.accounts.quote_account.slot;
        let staleness = current_slot.saturating_sub(quote_slot);

        msg!("Number of feeds: {}", feeds.len());
        msg!(
            " Quote slot: {}, Current slot: {}",
            quote_slot,
            current_slot
        );
        msg!(" Staleness: {} slots", staleness);
        let market_state = feeds[0]
            .value()
            .to_u8()
            .ok_or(CrankError::InvalidFeedValue)?;
        msg!("WRITING TO pda STATE ACCOUNT");
        ctx.accounts.market_status.current_state = market_state;
        ctx.accounts.market_status.last_updated_timestamp = Clock::get()?.unix_timestamp;

        // calculate zeh fee....
        let fee_bps: u16 = match ctx.accounts.market_status.current_state {
            0 => 0,    // 0%
            1 => 300,  // 3.0%
            2 => 700,  // 7.0%
            3 => 1800, // 18.0%
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

        // 3. Prepare the PDA signature (The "Corporate Stamp")
        let bump = ctx.bumps.fee_authority;
        let signer_seeds: &[&[&[u8]]] = &[&[b"fee_authority", &[bump]]];

        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

        // 4. Fire the CPI
        // The second parameter is the new fee. The third parameter is the max fee.
        // (You usually just pass the same fee_bps or your hardcoded 800 max).
        transfer_fee_set(cpi_ctx, fee_bps, 1900)?;
        Ok(())
    }
    pub fn initialize_state(ctx: Context<InitializeState>) -> Result<()> {
        let state = &mut ctx.accounts.market_status;

        state.current_state = 99;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct FundBounty<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"bounty_config"],
        bump = bounty_config.bump,
        has_one = authority @ CrankError::InvalidAuthority,
    )]
    pub bounty_config: Account<'info, BountyConfig>,
    /// CHECK: Just a lamport holding account
    #[account(
        mut,
        seeds = [b"bounty_vault"],
        bump,
    )]
    pub bounty_vault: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}
#[account]
pub struct BountyConfig {
    pub authority: Pubkey,  // Can only fund, never drain or change amount
    pub bounty_amount: u64, // lamports per crank (e.g., 0.005 SOL)
    pub last_crank_slot: u64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitializeBounty<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + 32 + 8 + 8 + 1,
        seeds = [b"bounty_config"],
        bump,
    )]
    pub bounty_config: Account<'info, BountyConfig>,
    /// CHECK: Just a lamport holding account
    #[account(
        init,
        payer = payer,
        space = 1,
        seeds = [b"bounty_vault"],
        bump,
    )]
    pub bounty_vault: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PermissionlessCrank<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,

    #[account(
        mut,
        seeds = [b"bounty_config"],
        bump = bounty_config.bump,
    )]
    pub bounty_config: Account<'info, BountyConfig>,

    #[account(
        mut,
        seeds = [b"bounty_vault"],
        bump,
    )]
    pub bounty_vault: AccountInfo<'info>,

    // --- Reuse existing ReadOracleData accounts ---
    #[account(address = quote_account.canonical_key(&default_queue()))]
    pub quote_account: Box<Account<'info, SwitchboardQuote>>,
    pub clock: Sysvar<'info, Clock>,
    #[account(mut)]
    pub market_status: Account<'info, MarketStatus>,
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(seeds = [b"fee_authority"], bump)]
    pub fee_authority: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
/// Account context for reading oracle data
///
/// This is designed to be as simple as possible while still being secure.
/// The quote_account is the canonical account derived from feed hashes.
#[derive(Accounts)]
pub struct ReadOracleData<'info> {
    #[account(address = quote_account.canonical_key(&default_queue()))]
    pub quote_account: Box<Account<'info, SwitchboardQuote>>,

    /// System variables required for quote verification
    pub clock: Sysvar<'info, Clock>,

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
