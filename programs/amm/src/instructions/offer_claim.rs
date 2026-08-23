// programs/amm/src/instructions/offer_claim.rs
//
// The night desk's taking instructions — one per payment currency:
//   offer_claim      buyer pays USDC
//   offer_claim_sol  buyer pays SOL (lamports, priced via the sol_oracle)
// Both buy discounted, vesting AFHO lots. Payment splits 80/10/10 at claim
// time: 80% stays in the buyback vault (dex_buyback spends it while the
// market is open), 10% to the dip reserve, 10% to the staker-rewards holding
// vault (converted to AFHO and distributed once per day by
// distribute_staker_rewards). Purchased AFHO never touches the buyer's
// wallet: it moves directly from the AMM vault into a locked StakePosition
// via CPI (vesting = offer.vesting_days trading days, enforced lazily by the
// staking program from entry_trading_day).
//
// Claims are only valid for TONIGHT's sheet while the market is after-hours
// or closed (states 1|2); the desk is dark while buybacks run.
//
// The floor (highest_buyback_basis) is USDC-denominated in BOTH paths: a SOL
// claim converts its USDC-terms cost to lamports at the sol_oracle rate, so
// the ratchet never mixes units.

use crate::state::offersState::{lot_sizer, AmmState, OfferList};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

// ---------------------------------------------------------------------------
// USDC payment
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(tier: u8, units: u8, index: u64)]
pub struct OfferClaim<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"amm_state", amm_state.afho_mint.as_ref()],
        bump = amm_state.bump,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

    #[account(
        mut,
        seeds = [b"offer_list", amm_state.afho_mint.as_ref()],
        bump = offer_list.bump,
    )]
    pub offer_list: Box<Account<'info, OfferList>>,

    #[account(address = amm_state.afho_mint)]
    pub afho_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = amm_state.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Absolute-price oracle. Address is pinned at init — an attacker cannot
    /// substitute a fake price account. (Raw-u64 mock PDA on devnet; real
    /// price source adapter at mainnet.)
    /// CHECK: address-verified against amm_state.spot_oracle
    #[account(address = amm_state.spot_oracle)]
    pub spot_oracle: UncheckedAccount<'info>,

    /// Market status PDA — gates claims to after-hours/closed and provides
    /// the trading day for sheet freshness.
    /// CHECK: seeds-verified against the crank program stored at init
    #[account(
        seeds = [b"market_status"],
        seeds::program = amm_state.crank_program,
        bump
    )]
    pub market_status: UncheckedAccount<'info>,

    /// Buyer's payment source (USDC)
    #[account(mut, token::mint = usdc_mint, token::authority = buyer)]
    pub buyer_usdc: Box<InterfaceAccount<'info, TokenAccount>>,

    /// 80% — buyback vault (dex_buyback spends from here)
    #[account(mut, address = amm_state.usdc_vault)]
    pub amm_usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// 10% — dip reserve
    #[account(mut, address = amm_state.usdc_dip)]
    pub usdc_dip: Box<InterfaceAccount<'info, TokenAccount>>,
    /// 10% — staker rewards holding vault
    #[account(mut, address = amm_state.usdc_rewards)]
    pub usdc_rewards: Box<InterfaceAccount<'info, TokenAccount>>,

    // --- staking CPI (position for the purchased, vesting AFHO) ---
    pub staking_program: Program<'info, staking::program::Staking>,
    #[account(mut, address = amm_state.staking_pool)]
    pub staking_pool: Box<Account<'info, staking::StakePool>>,
    /// CHECK: derived under the staking program; created by the CPI on the
    /// buyer's first claim. If it already exists, `index` must equal its
    /// stored next_index (checked in the handler).
    #[account(
        mut,
        seeds = [b"user_index", buyer.key().as_ref()],
        seeds::program = staking_program,
        bump
    )]
    pub user_index: UncheckedAccount<'info>,
    /// CHECK: position PDA created by the CPI
    #[account(
        mut,
        seeds = [
            b"position",
            staking_pool.key().as_ref(),
            buyer.key().as_ref(),
            &index.to_le_bytes(),
        ],
        seeds::program = staking_program,
        bump
    )]
    pub stake_position: UncheckedAccount<'info>,

    /// Source: AMM's AFHO reserve (authority = amm_state PDA)
    #[account(mut, address = amm_state.afho_vault)]
    pub amm_afho_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Destination: staking pool vault
    #[account(mut, address = staking_pool.vault)]
    pub staking_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Classic SPL (USDC legs)
    pub token_program: Interface<'info, TokenInterface>,
    /// Token-2022 (AFHO leg into staking)
    pub token_2022_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<OfferClaim>, tier: u8, units: u8, index: u64) -> Result<()> {
    let q = quote_claim(
        &ctx.accounts.market_status,
        &ctx.accounts.offer_list,
        &ctx.accounts.amm_state,
        ctx.accounts.afho_mint.decimals,
        &ctx.accounts.spot_oracle,
        tier,
        units,
    )?;

    // ── 80/10/10 split of the payment (rounding favors the buyback vault) ──
    let dip = q.cost_usdc / 10;
    let rewards = q.cost_usdc / 10;
    let buyback = q.cost_usdc - dip - rewards;

    let usdc_decimals = ctx.accounts.usdc_mint.decimals;
    for (to, amount) in [
        (ctx.accounts.amm_usdc_vault.to_account_info(), buyback),
        (ctx.accounts.usdc_dip.to_account_info(), dip),
        (ctx.accounts.usdc_rewards.to_account_info(), rewards),
    ] {
        if amount == 0 {
            continue;
        }
        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.buyer_usdc.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to,
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            amount,
            usdc_decimals,
        )?;
    }

    validate_user_index(&ctx.accounts.user_index.to_account_info(), index)?;
    settle_sheet(&mut ctx.accounts.offer_list, tier, units, q.total_tokens);
    let amm_state = &mut ctx.accounts.amm_state;
    amm_state.total_usdc_proceeds = amm_state.total_usdc_proceeds.saturating_add(q.cost_usdc);

    // ── CPI into staking: purchased AFHO goes DIRECTLY from the AMM vault
    // into a locked StakePosition (vesting = offer.vesting_days) ──
    let mint_key = amm_state.afho_mint;
    let state_bump = amm_state.bump;
    let seeds: &[&[u8]] = &[b"amm_state", mint_key.as_ref(), &[state_bump]];
    cpi_create_position(
        ctx.accounts.staking_program.to_account_info(),
        ctx.accounts.buyer.to_account_info(),
        ctx.accounts.afho_mint.to_account_info(),
        ctx.accounts.staking_pool.to_account_info(),
        ctx.accounts.amm_state.to_account_info(),
        ctx.accounts.user_index.to_account_info(),
        ctx.accounts.stake_position.to_account_info(),
        ctx.accounts.amm_afho_vault.to_account_info(),
        ctx.accounts.staking_vault.to_account_info(),
        ctx.accounts.market_status.to_account_info(),
        ctx.accounts.token_2022_program.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        seeds,
        q.total_raw,
        index,
        q.vesting_days,
    )?;

    msg!(
        "Claimed {} AFHO ({} lots, tier {}) at {} ({}bps off, floor: {}); paid {} usdc -> {} buyback / {} dip / {} rewards",
        q.total_tokens,
        units,
        tier,
        q.effective_price,
        q.discount_bps,
        q.floor,
        q.cost_usdc,
        buyback,
        dip,
        rewards,
    );

    Ok(())
}

// ---------------------------------------------------------------------------
// SOL payment — same desk, lamports in, priced via the SOL/USD oracle
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(tier: u8, units: u8, index: u64)]
pub struct OfferClaimSol<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"amm_state", amm_state.afho_mint.as_ref()],
        bump = amm_state.bump,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

    #[account(
        mut,
        seeds = [b"offer_list", amm_state.afho_mint.as_ref()],
        bump = offer_list.bump,
    )]
    pub offer_list: Box<Account<'info, OfferList>>,

    #[account(address = amm_state.afho_mint)]
    pub afho_mint: Box<InterfaceAccount<'info, Mint>>,

    /// AFHO absolute-price oracle (same as the USDC path)
    /// CHECK: address-verified against amm_state.spot_oracle
    #[account(address = amm_state.spot_oracle)]
    pub spot_oracle: UncheckedAccount<'info>,
    /// SOL/USD price oracle — raw u64, same units convention as spot_oracle:
    /// (usdc_raw x 1e6) / lamports. Address pinned at init.
    /// CHECK: address-verified against amm_state.sol_oracle
    #[account(address = amm_state.sol_oracle)]
    pub sol_oracle: UncheckedAccount<'info>,

    /// Market status PDA — same gate as the USDC path.
    /// CHECK: seeds-verified against the crank program stored at init
    #[account(
        seeds = [b"market_status"],
        seeds::program = amm_state.crank_program,
        bump
    )]
    pub market_status: UncheckedAccount<'info>,

    /// 80% — SOL buyback vault (dex_buyback's SOL leg spends from here)
    /// CHECK: address-verified system PDA
    #[account(mut, address = amm_state.sol_vault)]
    pub sol_vault: AccountInfo<'info>,
    /// 10% — SOL dip reserve
    /// CHECK: address-verified system PDA
    #[account(mut, address = amm_state.sol_dip)]
    pub sol_dip: AccountInfo<'info>,
    /// 10% — staker rewards holding vault (SOL)
    /// CHECK: address-verified system PDA
    #[account(mut, address = amm_state.sol_rewards)]
    pub sol_rewards: AccountInfo<'info>,

    // --- staking CPI (identical to the USDC path) ---
    pub staking_program: Program<'info, staking::program::Staking>,
    #[account(mut, address = amm_state.staking_pool)]
    pub staking_pool: Box<Account<'info, staking::StakePool>>,
    /// CHECK: derived under the staking program; next_index checked in handler
    #[account(
        mut,
        seeds = [b"user_index", buyer.key().as_ref()],
        seeds::program = staking_program,
        bump
    )]
    pub user_index: UncheckedAccount<'info>,
    /// CHECK: position PDA created by the CPI
    #[account(
        mut,
        seeds = [
            b"position",
            staking_pool.key().as_ref(),
            buyer.key().as_ref(),
            &index.to_le_bytes(),
        ],
        seeds::program = staking_program,
        bump
    )]
    pub stake_position: UncheckedAccount<'info>,

    /// Source: AMM's AFHO reserve (authority = amm_state PDA)
    #[account(mut, address = amm_state.afho_vault)]
    pub amm_afho_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Destination: staking pool vault
    #[account(mut, address = staking_pool.vault)]
    pub staking_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Token-2022 (AFHO leg into staking)
    pub token_2022_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler_sol(ctx: Context<OfferClaimSol>, tier: u8, units: u8, index: u64) -> Result<()> {
    let q = quote_claim(
        &ctx.accounts.market_status,
        &ctx.accounts.offer_list,
        &ctx.accounts.amm_state,
        ctx.accounts.afho_mint.decimals,
        &ctx.accounts.spot_oracle,
        tier,
        units,
    )?;

    // ── Convert the USDC-denominated cost into lamports ──
    // sol_price units match the spot oracle: (usdc_raw x 1e6) / lamports,
    // so lamports = cost_usdc x 1e6 / sol_price.
    let sol_price = read_live_price(&ctx.accounts.sol_oracle.to_account_info())?;
    require!(sol_price > 0, ErrorCode::InvalidOracle);
    let lamports = (q.cost_usdc as u128)
        .checked_mul(1_000_000u128)
        .ok_or(ErrorCode::MathOverflow)?
        / sol_price as u128;
    let lamports = u64::try_from(lamports).map_err(|_| ErrorCode::MathOverflow)?;
    require!(lamports > 0, ErrorCode::ZeroAmount);

    // ── 80/10/10 split of the payment (rounding favors the buyback vault) ──
    let dip = lamports / 10;
    let rewards = lamports / 10;
    let buyback = lamports - dip - rewards;

    let buyer_key = ctx.accounts.buyer.key();
    for (to, amount) in [
        (ctx.accounts.sol_vault.to_account_info(), buyback),
        (ctx.accounts.sol_dip.to_account_info(), dip),
        (ctx.accounts.sol_rewards.to_account_info(), rewards),
    ] {
        if amount == 0 {
            continue;
        }
        let to_key = to.key();
        anchor_lang::solana_program::program::invoke(
            &anchor_lang::solana_program::system_instruction::transfer(
                &buyer_key, &to_key, amount,
            ),
            &[
                ctx.accounts.buyer.to_account_info(),
                to,
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
    }

    validate_user_index(&ctx.accounts.user_index.to_account_info(), index)?;
    settle_sheet(&mut ctx.accounts.offer_list, tier, units, q.total_tokens);
    let amm_state = &mut ctx.accounts.amm_state;
    amm_state.total_sol_proceeds = amm_state.total_sol_proceeds.saturating_add(lamports);

    // ── CPI into staking (identical to the USDC path) ──
    let mint_key = amm_state.afho_mint;
    let state_bump = amm_state.bump;
    let seeds: &[&[u8]] = &[b"amm_state", mint_key.as_ref(), &[state_bump]];
    cpi_create_position(
        ctx.accounts.staking_program.to_account_info(),
        ctx.accounts.buyer.to_account_info(),
        ctx.accounts.afho_mint.to_account_info(),
        ctx.accounts.staking_pool.to_account_info(),
        ctx.accounts.amm_state.to_account_info(),
        ctx.accounts.user_index.to_account_info(),
        ctx.accounts.stake_position.to_account_info(),
        ctx.accounts.amm_afho_vault.to_account_info(),
        ctx.accounts.staking_vault.to_account_info(),
        ctx.accounts.market_status.to_account_info(),
        ctx.accounts.token_2022_program.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        seeds,
        q.total_raw,
        index,
        q.vesting_days,
    )?;

    msg!(
        "Claimed {} AFHO ({} lots, tier {}) at {} ({}bps off, floor: {}); paid {} lamports -> {} buyback / {} dip / {} rewards",
        q.total_tokens,
        units,
        tier,
        q.effective_price,
        q.discount_bps,
        q.floor,
        lamports,
        buyback,
        dip,
        rewards,
    );

    Ok(())
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

struct ClaimQuote {
    total_tokens: u64,
    total_raw: u64,
    cost_usdc: u64,
    vesting_days: u8,
    effective_price: u64,
    discount_bps: u64,
    floor: u64,
}

/// Gates + pricing, shared by both currencies. Enforces the night-desk market
/// gate, sheet freshness, tier terms, discount, and the ratchet floor; returns
/// the token amount and the USDC-denominated cost.
fn quote_claim(
    market_status: &AccountInfo,
    offer_list: &Account<OfferList>,
    amm_state: &Account<AmmState>,
    afho_decimals: u8,
    spot_oracle: &AccountInfo,
    tier: u8,
    units: u8,
) -> Result<ClaimQuote> {
    require!(units > 0, ErrorCode::ZeroAmount);

    // ── Market gate: the desk trades at night only ──
    // MarketStatus layout: disc(8) + current_state(1) + timestamp(8) + trading_day_index(8)
    let market_data = market_status.try_borrow_data()?;
    require!(market_data.len() >= 25, ErrorCode::InvalidMarketStatus);
    let current_state = market_data[8];
    let current_day = u64::from_le_bytes(market_data[17..25].try_into().unwrap());
    require!(
        current_state == 1 || current_state == 2,
        ErrorCode::DeskClosed
    );

    // ── Freshness: only tonight's sheet is claimable ──
    require!(
        offer_list.day_index == current_day,
        ErrorCode::StaleOfferSheet
    );

    // ── Tier terms (copies) ──
    let offer = match tier {
        0 => offer_list.sml_offer,
        1 => offer_list.med_offer,
        2 => offer_list.big_offer,
        _ => return err!(ErrorCode::InvalidTier),
    };
    require!(offer.remaining >= units, ErrorCode::InsufficientOffer);
    let (lot_tier, vesting_days, discount_stored) =
        (offer.lot_size, offer.vesting_days, offer.discount_bps);

    // ── Price: live absolute price minus the tier discount ──
    // discount_bps is stored in tenths of a percent (115 = 11.5%) → ×10 = bps.
    let live_price = read_live_price(spot_oracle)?;
    let discount_bps = discount_stored as u64 * 10;
    let discounted = live_price.saturating_sub(live_price.saturating_mul(discount_bps) / 10_000);

    // ── RATCHET: never sell below highest realized buyback basis ──
    let floor = amm_state.highest_buyback_basis;
    let effective_price = discounted.max(floor);
    if effective_price > discounted {
        msg!(
            "Ratchet active: floor {} vs discounted {}",
            floor,
            discounted
        );
    }

    // lot_size is a TIER INDEX — translate via lot_sizer to whole tokens,
    // then to raw units. Price units: (usdc_raw × 1e6) / afho_raw.
    let unit = 10u64.checked_pow(afho_decimals as u32).unwrap_or(1);
    let total_tokens = lot_sizer(lot_tier) as u64 * units as u64;
    require!(total_tokens > 0, ErrorCode::InsufficientOffer);
    let total_raw = (total_tokens as u128)
        .checked_mul(unit as u128)
        .ok_or(ErrorCode::MathOverflow)?;
    let cost = total_raw
        .checked_mul(effective_price as u128)
        .ok_or(ErrorCode::MathOverflow)?
        / 1_000_000u128;
    let cost_usdc = u64::try_from(cost).map_err(|_| ErrorCode::MathOverflow)?;
    require!(cost_usdc > 0, ErrorCode::ZeroAmount);

    Ok(ClaimQuote {
        total_tokens,
        total_raw: u64::try_from(total_raw).map_err(|_| ErrorCode::MathOverflow)?,
        cost_usdc,
        vesting_days,
        effective_price,
        discount_bps,
        floor,
    })
}

/// Client-supplied position index must match the staking user_index (if it
/// already exists), so position PDAs can never collide.
fn validate_user_index(user_index: &AccountInfo, index: u64) -> Result<()> {
    if !user_index.data_is_empty() {
        require!(user_index.owner == &staking::ID, ErrorCode::InvalidUserIndex);
        let data = user_index.try_borrow_data()?;
        require!(data.len() >= 16, ErrorCode::InvalidUserIndex);
        let next = u64::from_le_bytes(data[8..16].try_into().unwrap());
        require!(next == index, ErrorCode::InvalidUserIndex);
    }
    Ok(())
}

/// Sheet accounting: decrement the tier's remaining lots; total_complete is
/// in WHOLE TOKENS, not lots.
fn settle_sheet(offer_list: &mut Account<OfferList>, tier: u8, units: u8, total_tokens: u64) {
    match tier {
        0 => offer_list.sml_offer.remaining -= units,
        1 => offer_list.med_offer.remaining -= units,
        _ => offer_list.big_offer.remaining -= units,
    }
    offer_list.total_complete = offer_list
        .total_complete
        .saturating_add(total_tokens as u32);
}

/// CPI into staking: purchased AFHO moves from the AMM vault into a locked
/// StakePosition. The amm_state PDA signs (the staking program verifies its
/// seeds against pool.amm_program — that signature IS the authorization).
#[allow(clippy::too_many_arguments)]
fn cpi_create_position<'info>(
    staking_program: AccountInfo<'info>,
    owner: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    pool: AccountInfo<'info>,
    amm_state: AccountInfo<'info>,
    user_index: AccountInfo<'info>,
    position: AccountInfo<'info>,
    source_token: AccountInfo<'info>,
    vault: AccountInfo<'info>,
    market_status: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
    signer_seeds: &[&[u8]],
    amount_raw: u64,
    index: u64,
    vesting_days: u8,
) -> Result<()> {
    staking::cpi::create_amm_position(
        CpiContext::new_with_signer(
            staking_program,
            staking::cpi::accounts::CreateAmmPosition {
                owner,
                mint,
                pool,
                amm_state,
                user_index,
                position,
                source_token,
                vault,
                market_status,
                token_program,
                system_program,
            },
            &[signer_seeds],
        ),
        amount_raw,
        index,
        vesting_days,
    )
}

pub(crate) fn read_live_price(oracle: &AccountInfo) -> Result<u64> {
    let data = oracle.try_borrow_data()?;
    require!(data.len() >= 8, ErrorCode::InvalidOracle);
    Ok(u64::from_le_bytes(data[0..8].try_into().unwrap()))
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid tier")]
    InvalidTier,
    #[msg("Insufficient offer remaining")]
    InsufficientOffer,
    #[msg("Zero amount")]
    ZeroAmount,
    #[msg("Invalid price oracle")]
    InvalidOracle,
    #[msg("Invalid market status account")]
    InvalidMarketStatus,
    #[msg("Offer desk is closed while the market is open or halted")]
    DeskClosed,
    #[msg("Offer sheet is stale (not today's sheet)")]
    StaleOfferSheet,
    #[msg("Position index does not match the staking user_index")]
    InvalidUserIndex,
    #[msg("Math overflow")]
    MathOverflow,
}
