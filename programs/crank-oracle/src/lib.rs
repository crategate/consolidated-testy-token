use anchor_lang::prelude::*;
use switchboard_on_demand::prelude::rust_decimal::prelude::ToPrimitive;
use switchboard_on_demand::{default_queue, SwitchboardQuote, SwitchboardQuoteExt};

declare_id!("HkA18DxZU3RSg2cJfC1vZEkkRmDnSWuXjHim2NXbao7U");

const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
const POOL_VAULT_SEED: &[u8] = b"pool_vault";

#[error_code]
pub enum CrankError {
    #[msg("No feeds found in oracle quote")]
    NoFeeds,
    #[msg("Feed value could not be converted to u8")]
    InvalidFeedValue,
    #[msg("Market state must be 0-3 (open/after-hours/closed/halted)")]
    InvalidMarketState,
    #[msg("Wrong authority payer key bounty_config")]
    InvalidAuthority,
    #[msg("Quote provided too stale")]
    QuoteTooStale,
    #[msg("Oracle quote is not newer than last crank")]
    StaleQuote,
    #[msg("Bounty vault is empty")]
    BountyExhausted,
    #[msg("SOL/USDC price could not be read")]
    InvalidSolPrice,
    #[msg("Math overflow")]
    MathOverflow,
}

#[program]
pub mod crank_oracle {
    use super::*;

    pub fn initialize_bounty(
        ctx: Context<InitializeBounty>,
        bounty_amount: u64,
        bounty_usd_raw: u64,
        base_year: u16,
        annual_inflation_bps: u16,
        sol_usdc_pool: Pubkey,
        cpmm_program: Pubkey,
        usdc_mint: Pubkey,
    ) -> Result<()> {
        ctx.accounts.bounty_config.set_inner(BountyConfig {
            authority: ctx.accounts.payer.key(),
            bounty_amount,
            bounty_usd_raw,
            base_year,
            annual_inflation_bps,
            last_crank_slot: 0,
            sol_usdc_pool,
            cpmm_program,
            usdc_mint,
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

        let feeds = &ctx.accounts.quote_account.feeds;
        require!(!feeds.is_empty(), CrankError::NoFeeds);

        let market_state = feeds[0]
            .value()
            .to_u8()
            .ok_or(CrankError::InvalidFeedValue)?;
        require!(market_state <= 3, CrankError::InvalidMarketState);

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

        // Bounty is paid ONLY on a real state transition. Without this gate,
        // anyone who pushes a fresh Switchboard quote and cranks would collect
        // the bounty every quote slot (24/7), so the burn rate would track
        // Solana slot cadence instead of protocol events. market_status is a
        // state machine driven by NYSE hours: transitions happen ~2x/day
        // (open/close) plus halts. The bounty should reward the bot that posts
        // the CHANGE, not a heartbeat — so a no-op crank updates state for
        // free but is not paid.
        if market_state == old_state {
            msg!(
                "Heartbeat crank (no state change) — no bounty. State: {}",
                market_state
            );
            return Ok(());
        }

        // Payout amount. USD-denominated when the SOL/USDC pool is pinned:
        // lamports = (usd_raw × 1e6) / sol_price_floor, where usd_raw is the
        // base bounty escalated 5%/yr (or the configured bps) since base_year.
        // Falls back to the fixed lamport bounty when the pool isn't set.
        let cfg = &ctx.accounts.bounty_config;
        let bounty = if cfg.sol_usdc_pool != Pubkey::default() {
            let wsol_vault = ctx
                .accounts
                .sol_usdc_wsol_vault
                .as_ref()
                .ok_or(CrankError::InvalidSolPrice)?;
            let usdc_vault = ctx
                .accounts
                .sol_usdc_usdc_vault
                .as_ref()
                .ok_or(CrankError::InvalidSolPrice)?;
            // Pin the two vaults to the pool's derived PDAs.
            let (expected_wsol, _) = Pubkey::find_program_address(
                &[
                    POOL_VAULT_SEED,
                    cfg.sol_usdc_pool.as_ref(),
                    WSOL_MINT.as_ref(),
                ],
                &cfg.cpmm_program,
            );
            let (expected_usdc, _) = Pubkey::find_program_address(
                &[
                    POOL_VAULT_SEED,
                    cfg.sol_usdc_pool.as_ref(),
                    cfg.usdc_mint.as_ref(),
                ],
                &cfg.cpmm_program,
            );
            require!(
                wsol_vault.key() == expected_wsol && usdc_vault.key() == expected_usdc,
                CrankError::InvalidSolPrice
            );
            let sol_price = read_sol_usdc_price(wsol_vault, usdc_vault)?;
            require!(sol_price > 0, CrankError::InvalidSolPrice);
            let year = year_from_unix(ctx.accounts.clock.unix_timestamp);
            let usd_raw = effective_bounty_usd(cfg, year)?;
            (usd_raw as u128 * 1_000_000u128 / sol_price as u128) as u64
        } else {
            cfg.bounty_amount
        };
        require!(bounty > 0, CrankError::InvalidSolPrice);
        require!(
            ctx.accounts.bounty_vault.lamports()
                >= bounty + Rent::get()?.minimum_balance(1),
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
        let quote_slot = ctx.accounts.quote_account.slot;
        let last_slot = ctx.accounts.bounty_config.last_crank_slot;
        let current_slot = ctx.accounts.clock.slot;
        let staleness = current_slot.saturating_sub(quote_slot);

        let max_age = match ctx.accounts.market_status.current_state {
            0 | 1 => 100,
            _ => 300,
        };
        require!(staleness <= max_age, CrankError::QuoteTooStale);
        // This path WRITES market state but never pays, so it must still
        // consume the quote slot: otherwise the same fresh quote could be
        // replayed to burn a transition before the paying cranker sees it
        // (the monotonic check would still pass for the paying path, but the
        // state would already have flipped, so no bounty).
        require!(quote_slot > last_slot, CrankError::StaleQuote);

        let feeds = &ctx.accounts.quote_account.feeds;
        require!(!feeds.is_empty(), CrankError::NoFeeds);

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
        require!(new_state <= 3, CrankError::InvalidMarketState);

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
        ctx.accounts.bounty_config.last_crank_slot = quote_slot;

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

    pub fn set_bounty_amount(ctx: Context<UpdateBounty>, new_amount: u64) -> Result<()> {
        ctx.accounts.bounty_config.bounty_amount = new_amount;
        msg!("Bounty fallback amount set to: {}", new_amount);
        Ok(())
    }

    pub fn set_bounty_usd(ctx: Context<UpdateBounty>, new_usd_raw: u64) -> Result<()> {
        ctx.accounts.bounty_config.bounty_usd_raw = new_usd_raw;
        msg!("USD bounty set to {} usdc raw", new_usd_raw);
        Ok(())
    }

    pub fn set_authority(ctx: Context<UpdateBounty>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.bounty_config.authority = new_authority;
        msg!("Bounty authority rotated to: {}", new_authority);
        Ok(())
    }
    // DEVNET/TEST ONLY — remove before mainnet (paired with the script
    // scripts/oracle/set-oracle-state.ts, which refuses non-devnet clusters;
    // the instruction itself has no gate and must be deleted alongside it).
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
    /// Fallback lamport payout used when the SOL/USDC pool isn't configured.
    pub bounty_amount: u64,
    /// USD-denominated payout in USDC raw units (6 dp). $0.50 = 500_000.
    pub bounty_usd_raw: u64,
    /// Calendar year the USD bounty is denominated in (inflation baseline).
    pub base_year: u16,
    /// Annual inflation in bps (500 = +5%/yr) applied each year after base_year.
    pub annual_inflation_bps: u16,
    pub last_crank_slot: u64,
    /// Pinned Raydium SOL/USDC CPMM pool + program + USDC mint for the
    /// USD→SOL conversion at payout time.
    pub sol_usdc_pool: Pubkey,
    pub cpmm_program: Pubkey,
    pub usdc_mint: Pubkey,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitializeBounty<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + 32 + 8 + 8 + 2 + 2 + 8 + 32 + 32 + 32 + 1, seeds = [b"bounty_config"], bump)]
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
    /// CHECK: SOL/USDC pool wSOL vault (vault-ratio price read). None when the
    /// pool isn't configured; pinned in the handler when it is.
    pub sol_usdc_wsol_vault: Option<AccountInfo<'info>>,
    /// CHECK: SOL/USDC pool USDC vault. See above.
    pub sol_usdc_usdc_vault: Option<AccountInfo<'info>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReadOracleData<'info> {
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [b"bounty_config"], bump = bounty_config.bump)]
    pub bounty_config: Account<'info, BountyConfig>,
    #[account(address = quote_account.canonical_key(&default_queue()))]
    pub quote_account: Box<Account<'info, SwitchboardQuote>>,
    pub clock: Sysvar<'info, Clock>,
    #[account(mut, seeds = [b"market_status"], bump)]
    pub market_status: Account<'info, MarketStatus>,
}

#[derive(Accounts)]
pub struct UpdateBounty<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"bounty_config"],
        bump = bounty_config.bump,
        has_one = authority @ CrankError::InvalidAuthority,
    )]
    pub bounty_config: Account<'info, BountyConfig>,
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

// ────────────────────────────── USD bounty helpers ─────────────────────────

/// Calendar year from a unix timestamp (exact integer civil-date algorithm;
/// no floating point on-chain).
fn year_from_unix(ts: i64) -> u16 {
    let days = ts.div_euclid(86_400); // days since 1970-01-01
    let z = days + 719_468;           // shift to the 0000-03-01 civil epoch
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = mp + if mp < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }
    year as u16
}

/// Base USD bounty escalated by `annual_inflation_bps` per calendar year since
/// `base_year` (compounded).
fn effective_bounty_usd(cfg: &BountyConfig, year: u16) -> Result<u64> {
    let years = (year as u32).saturating_sub(cfg.base_year as u32);
    let mut usd = cfg.bounty_usd_raw as u128;
    let scale = 10_000u128 + cfg.annual_inflation_bps as u128;
    for _ in 0..years {
        usd = usd
            .checked_mul(scale)
            .ok_or(CrankError::MathOverflow)?
            / 10_000;
    }
    Ok(usd as u64)
}

/// SOL/USDC price in floor units — (usdc_raw × 1e6) / wsol_raw — from the two
/// pool vault token accounts.
fn read_sol_usdc_price(wsol_vault: &AccountInfo, usdc_vault: &AccountInfo) -> Result<u64> {
    let wsol_raw = token_account_amount(wsol_vault)?;
    let usdc_raw = token_account_amount(usdc_vault)?;
    require!(wsol_raw > 0, CrankError::InvalidSolPrice);
    Ok((usdc_raw as u128 * 1_000_000u128 / wsol_raw as u128) as u64)
}

/// Token-account `amount` field (u64 LE at offset 64), SPL and Token-2022.
fn token_account_amount(account: &AccountInfo) -> Result<u64> {
    let data = account.try_borrow_data()?;
    require!(data.len() >= 72, CrankError::InvalidSolPrice);
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}