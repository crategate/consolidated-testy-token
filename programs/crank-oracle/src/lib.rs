use anchor_lang::prelude::*;
use switchboard_on_demand::prelude::rust_decimal::prelude::ToPrimitive;
use switchboard_on_demand::{default_queue, SwitchboardQuote, SwitchboardQuoteExt};

declare_id!("ENJn9r8uCBLZXJ4unADAJfgNScWZuEm3rHD2LoBDpAki");

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
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.payer.to_account_info(),
                to: ctx.accounts.bounty_vault.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(cpi_ctx, amount)?;
        Ok(())
    }
    pub fn permissionless_crank(ctx: Context<PermissionlessCrank>) -> Result<()> {
        let quote_slot = ctx.accounts.quote_account.slot;
        let last_slot = ctx.accounts.bounty_config.last_crank_slot;
        let current_slot = ctx.accounts.clock.slot;
        let staleness = current_slot.saturating_sub(quote_slot);

        let max_age = match ctx.accounts.market_status.current_state {
            0 | 1 => 100,
            _ => 300,
        };
        require!(staleness <= max_age, CrankError::QuoteTooStale);
        require!(quote_slot > last_slot, CrankError::StaleQuote);

        let market_state = ctx.accounts.quote_account.feeds[0]
            .value()
            .to_u8()
            .ok_or(CrankError::InvalidFeedValue)?;

        let market_status = &mut ctx.accounts.market_status;
        let old_state = market_status.current_state;

        if (old_state == 1 || old_state == 2) && market_state == 0 {
            market_status.trading_day_index =
                market_status.trading_day_index.checked_add(1).unwrap();
            msg!(
                "Market closed. Trading day index: {}",
                market_status.trading_day_index
            );
        }

        market_status.current_state = market_state;
        market_status.last_updated_timestamp = Clock::get()?.unix_timestamp;
        ctx.accounts.bounty_config.last_crank_slot = quote_slot;

        let bounty = ctx.accounts.bounty_config.bounty_amount;
        require!(
            ctx.accounts.bounty_vault.lamports() >= bounty,
            CrankError::BountyExhausted
        );

        // Manual lamport transfer from program-owned PDA
        let vault_info = ctx.accounts.bounty_vault.to_account_info();
        let cranker_info = ctx.accounts.cranker.to_account_info();

        let mut vault_lamports = vault_info.try_borrow_mut_lamports()?;
        let mut cranker_lamports = cranker_info.try_borrow_mut_lamports()?;

        **vault_lamports -= bounty;
        **cranker_lamports += bounty;

        drop(vault_lamports);
        drop(cranker_lamports);

        msg!(
            "Cranked by {}. Bounty paid: {} lamports. State: {}",
            ctx.accounts.cranker.key(),
            bounty,
            market_state
        );
        Ok(())
    }
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

        if (old_state == 1 || old_state == 2) && new_state == 0 {
            market_status.trading_day_index =
                market_status.trading_day_index.checked_add(1).unwrap();
            msg!(
                "Market closed. Trading day index:   {}",
                market_status.trading_day_index
            );
        }

        market_status.current_state = new_state;
        market_status.last_updated_timestamp = Clock::get()?.unix_timestamp;

        msg!(
            "Market state: {} |& Timestamp: {}",
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
    // Add this instruction for testing ONLY — remove before mainnet
    pub fn test_set_state(ctx: Context<TestSetState>, state: u8, day: u64, ts: i64) -> Result<()> {
        ctx.accounts.market_status.current_state = state;
        ctx.accounts.market_status.trading_day_index = day;
        ctx.accounts.market_status.last_updated_timestamp = ts;
        msg!("Test state set to: {} day {} ts {}", state, day, ts);
        Ok(())
    }
}
#[derive(Accounts)]
pub struct TestSetState<'info> {
    #[account(mut, seeds = [b"market_status"], bump)]
    pub market_status: Account<'info, MarketStatus>,
}

#[derive(Accounts)]
pub struct FundBounty<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"bounty_config"],
        bump = bounty_config.bump,
    )]
    pub bounty_config: Account<'info, BountyConfig>,
    /// CHECK: Lamport holding account for bounty payouts
    #[account(mut, seeds = [b"bounty_vault"], bump)]
    pub bounty_vault: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}
#[account]
pub struct BountyConfig {
    pub authority: Pubkey,
    pub bounty_amount: u64,
    pub last_crank_slot: u64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitializeBounty<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + 32 + 8 + 8 + 1, seeds = [b"bounty_config"], bump)]
    pub bounty_config: Account<'info, BountyConfig>,
    /// CHECK: Lamport holding account for bounty payouts
    #[account(init, payer = payer, space = 1, seeds = [b"bounty_vault"], bump)]
    pub bounty_vault: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PermissionlessCrank<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [b"bounty_config"], bump = bounty_config.bump)]
    pub bounty_config: Account<'info, BountyConfig>,
    /// CHECK: Lamport holding account for bounty payouts
    #[account(mut, seeds = [b"bounty_vault"], bump)]
    pub bounty_vault: AccountInfo<'info>,
    #[account(address = quote_account.canonical_key(&default_queue()))]
    pub quote_account: Box<Account<'info, SwitchboardQuote>>,
    pub clock: Sysvar<'info, Clock>,
    #[account(mut, seeds = [b"market_status"], bump)]
    pub market_status: Account<'info, MarketStatus>,
    pub system_program: Program<'info, System>,
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
    pub current_state: u8,
    pub last_updated_timestamp: i64,
    pub trading_day_index: u64,
}

#[derive(Accounts)]
pub struct InitializeState<'info> {
    #[account(init, payer = payer, space = 8 + 32, seeds = [b"market_status"], bump)]
    pub market_status: Account<'info, MarketStatus>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}
