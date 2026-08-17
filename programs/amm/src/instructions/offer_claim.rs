// programs/amm/src/instructions/offer_claim.rs
//
// The night desk's taking instruction. A buyer pays USDC for discounted,
// vesting NYSEH lots:
//   - Payment splits 80/10/10 at claim time: 80% stays in the buyback vault
//     (dex_buyback spends it while the market is open), 10% to the dip
//     reserve, 10% to the staker-rewards holding vault (converted to NYSEH
//     and distributed once per day by distribute_staker_rewards).
//   - Purchased NYSEH never touches the buyer's wallet: it moves directly
//     from the AMM vault into a locked StakePosition via CPI (vesting =
//     offer.vesting_days trading days, enforced lazily by the staking
//     program from entry_trading_day).
//
// Claims are only valid for TONIGHT's sheet while the market is after-hours
// or closed (states 1|2); the desk is dark while buybacks run.

use crate::state::offersState::{lot_sizer, AmmState, OfferList};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

#[derive(Accounts)]
#[instruction(tier: u8, units: u8, index: u64)]
pub struct OfferClaim<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"amm_state", amm_state.nyseh_mint.as_ref()],
        bump = amm_state.bump,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

    #[account(
        mut,
        seeds = [b"offer_list", amm_state.nyseh_mint.as_ref()],
        bump = offer_list.bump,
    )]
    pub offer_list: Box<Account<'info, OfferList>>,

    #[account(address = amm_state.nyseh_mint)]
    pub nyseh_mint: Box<InterfaceAccount<'info, Mint>>,
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

    // --- staking CPI (position for the purchased, vesting NYSEH) ---
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

    /// Source: AMM's NYSEH reserve (authority = amm_state PDA)
    #[account(mut, address = amm_state.nyseh_vault)]
    pub amm_nyseh_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Destination: staking pool vault
    #[account(mut, address = staking_pool.vault)]
    pub staking_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Classic SPL (USDC legs)
    pub token_program: Interface<'info, TokenInterface>,
    /// Token-2022 (NYSEH leg into staking)
    pub token_2022_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<OfferClaim>, tier: u8, units: u8, index: u64) -> Result<()> {
    require!(units > 0, ErrorCode::ZeroAmount);

    // ── Market gate: the desk trades at night only ──
    // MarketStatus layout: disc(8) + current_state(1) + timestamp(8) + trading_day_index(8)
    let market_data = ctx.accounts.market_status.try_borrow_data()?;
    require!(market_data.len() >= 25, ErrorCode::InvalidMarketStatus);
    let current_state = market_data[8];
    let current_day = u64::from_le_bytes(market_data[17..25].try_into().unwrap());
    require!(
        current_state == 1 || current_state == 2,
        ErrorCode::DeskClosed
    );

    // ── Freshness: only tonight's sheet is claimable ──
    require!(
        ctx.accounts.offer_list.day_index == current_day,
        ErrorCode::StaleOfferSheet
    );

    // ── Select tier and read its terms (copies; borrows drop before CPI) ──
    let offer = match tier {
        0 => ctx.accounts.offer_list.sml_offer,
        1 => ctx.accounts.offer_list.med_offer,
        2 => ctx.accounts.offer_list.big_offer,
        _ => return err!(ErrorCode::InvalidTier),
    };
    require!(offer.remaining >= units, ErrorCode::InsufficientOffer);
    let (lot_tier, vesting_days, discount_stored) =
        (offer.lot_size, offer.vesting_days, offer.discount_bps);

    // ── Price: live absolute price minus the tier discount ──
    // discount_bps is stored in tenths of a percent (115 = 11.5%) → ×10 = bps.
    let live_price = read_live_price(&ctx.accounts.spot_oracle)?;
    let discount_bps = discount_stored as u64 * 10;
    let discounted = live_price.saturating_sub(live_price.saturating_mul(discount_bps) / 10_000);

    // ── RATCHET: never sell below highest realized buyback basis ──
    let floor = ctx.accounts.amm_state.highest_buyback_basis;
    let effective_price = discounted.max(floor);
    if effective_price > discounted {
        msg!(
            "Ratchet active: floor {} vs discounted {}",
            floor,
            discounted
        );
    }

    // lot_size is a TIER INDEX — translate via lot_sizer to whole tokens,
    // then to raw units. Price units: (usdc_raw × 1e6) / nyseh_raw.
    let unit = 10u64
        .checked_pow(ctx.accounts.nyseh_mint.decimals as u32)
        .unwrap_or(1);
    let total_tokens = lot_sizer(lot_tier) as u64 * units as u64;
    require!(total_tokens > 0, ErrorCode::InsufficientOffer);
    let total_raw = (total_tokens as u128)
        .checked_mul(unit as u128)
        .ok_or(ErrorCode::MathOverflow)?;
    let cost = total_raw
        .checked_mul(effective_price as u128)
        .ok_or(ErrorCode::MathOverflow)?
        / 1_000_000u128;
    let cost = u64::try_from(cost).map_err(|_| ErrorCode::MathOverflow)?;
    require!(cost > 0, ErrorCode::ZeroAmount);

    // ── 80/10/10 split of the payment (rounding favors the buyback vault) ──
    let dip = cost / 10;
    let rewards = cost / 10;
    let buyback = cost - dip - rewards;

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

    // ── Client-supplied position index must match the staking user_index ──
    let ui = &ctx.accounts.user_index;
    if !ui.data_is_empty() {
        require!(ui.owner == &staking::ID, ErrorCode::InvalidUserIndex);
        let data = ui.try_borrow_data()?;
        require!(data.len() >= 16, ErrorCode::InvalidUserIndex);
        let next = u64::from_le_bytes(data[8..16].try_into().unwrap());
        require!(next == index, ErrorCode::InvalidUserIndex);
    }

    // ── Update sheet accounting ──
    let offer_list = &mut ctx.accounts.offer_list;
    match tier {
        0 => offer_list.sml_offer.remaining -= units,
        1 => offer_list.med_offer.remaining -= units,
        _ => offer_list.big_offer.remaining -= units,
    }
    offer_list.total_complete = offer_list
        .total_complete
        .saturating_add(total_tokens as u32);

    let amm_state = &mut ctx.accounts.amm_state;
    amm_state.total_usdc_proceeds = amm_state.total_usdc_proceeds.saturating_add(cost);

    // ── CPI into staking: purchased NYSEH goes DIRECTLY from the AMM vault
    // into a locked StakePosition (vesting = offer.vesting_days) ──
    let mint_key = amm_state.nyseh_mint;
    let state_bump = amm_state.bump;
    let seeds: &[&[u8]] = &[b"amm_state", mint_key.as_ref(), &[state_bump]];
    staking::cpi::create_amm_position(
        CpiContext::new_with_signer(
            ctx.accounts.staking_program.to_account_info(),
            staking::cpi::accounts::CreateAmmPosition {
                owner: ctx.accounts.buyer.to_account_info(),
                mint: ctx.accounts.nyseh_mint.to_account_info(),
                pool: ctx.accounts.staking_pool.to_account_info(),
                amm_state: ctx.accounts.amm_state.to_account_info(),
                user_index: ctx.accounts.user_index.to_account_info(),
                position: ctx.accounts.stake_position.to_account_info(),
                source_token: ctx.accounts.amm_nyseh_vault.to_account_info(),
                vault: ctx.accounts.staking_vault.to_account_info(),
                market_status: ctx.accounts.market_status.to_account_info(),
                token_program: ctx.accounts.token_2022_program.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            &[seeds],
        ),
        u64::try_from(total_raw).map_err(|_| ErrorCode::MathOverflow)?,
        index,
        vesting_days,
    )?;

    msg!(
        "Claimed {} NYSEH ({} lots, tier {}) at {} ({}bps off, floor: {}); paid {} usdc -> {} buyback / {} dip / {} rewards",
        total_tokens,
        units,
        tier,
        effective_price,
        discount_bps,
        floor,
        cost,
        buyback,
        dip,
        rewards,
    );

    Ok(())
}

fn read_live_price(spot_oracle: &AccountInfo) -> Result<u64> {
    let data = spot_oracle.try_borrow_data()?;
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
