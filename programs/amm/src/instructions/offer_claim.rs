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
// the ratchet never mixes units. The buyer covers the CPMM 0.25% input fee
// (+25bps on the lamports); min-out tolerates 2% pool drift/slippage.

use crate::state::offersState::{lot_sizer, AmmState, OfferList};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};
use anchor_spl::associated_token::{create_idempotent, AssociatedToken, Create};
use anchor_spl::token::{sync_native, SyncNative};

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

    /// Absolute-price oracle (mock fallback). Address is pinned at init — an
    /// attacker cannot substitute a fake price account. Used only when the
    /// CPMM pool is NOT pinned (localnet tests / pre-mainnet devnet).
    /// CHECK: address-verified against amm_state.spot_oracle
    #[account(address = amm_state.spot_oracle)]
    pub spot_oracle: UncheckedAccount<'info>,

    // Raydium CPMM AFHO/USDC pool — live price source when the pool is pinned
    // in state (set_cpmm_pool). Option so mock-mode tests can omit them.
    /// CHECK: pool state, pinned to amm_state.cpmm_pool_state in the handler
    pub cpmm_pool_state: Option<AccountInfo<'info>>,
    /// CHECK: pool observation (TWAP ring)
    pub cpmm_observation: Option<AccountInfo<'info>>,
    /// CHECK: pool USDC vault (quote leg)
    pub cpmm_input_vault: Option<AccountInfo<'info>>,
    /// CHECK: pool AFHO vault (base leg)
    pub cpmm_output_vault: Option<AccountInfo<'info>>,

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
    let clock = Clock::get()?;
    let amm_state = &ctx.accounts.amm_state;
    let pinned = amm_state.cpmm_pool_state != Pubkey::default();
    require_pinned_pricing_accounts(
        pinned,
        amm_state.cpmm_program,
        amm_state.cpmm_pool_state,
        &ctx.accounts.afho_mint.key(),
        &ctx.accounts.usdc_mint.key(),
        ctx.accounts.cpmm_pool_state.as_ref(),
        ctx.accounts.cpmm_observation.as_ref(),
        ctx.accounts.cpmm_output_vault.as_ref(),
        ctx.accounts.cpmm_input_vault.as_ref(),
    )?;
    let live_price = if pinned {
        super::raydium::read_cpmm_price_floor(
            ctx.accounts.cpmm_pool_state.as_ref().unwrap(),
            ctx.accounts.cpmm_observation.as_ref().unwrap(),
            ctx.accounts.cpmm_output_vault.as_ref().unwrap(),
            ctx.accounts.cpmm_input_vault.as_ref().unwrap(),
            &ctx.accounts.afho_mint.key(),
            &ctx.accounts.usdc_mint.key(),
            clock.unix_timestamp as u64,
        )
        .ok_or(ErrorCode::InvalidOracle)?
    } else {
        read_live_price(&ctx.accounts.spot_oracle.to_account_info())?
    };

    let q = quote_claim(
        &ctx.accounts.market_status,
        &ctx.accounts.offer_list,
        &ctx.accounts.amm_state,
        ctx.accounts.afho_mint.decimals,
        live_price,
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
    #[account(address = amm_state.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    /// AFHO absolute-price oracle — fallback when the AFHO/USDC CPMM pool is
    /// NOT pinned. Optional so the pinned path can omit it (the SOL claim
    /// instruction is at the transaction-size limit; 2 fewer accounts matter).
    /// CHECK: address-verified against amm_state.spot_oracle when present.
    #[account(address = amm_state.spot_oracle)]
    pub spot_oracle: Option<AccountInfo<'info>>,
    /// SOL/USD price oracle — fallback when the SOL/USDC pool is NOT pinned.
    /// Optional for the same transaction-size reason.
    /// CHECK: address-verified against amm_state.sol_oracle when present.
    #[account(address = amm_state.sol_oracle)]
    pub sol_oracle: Option<AccountInfo<'info>>,

    // Raydium CPMM AFHO/USDC pool — live spot-price source when pinned.
    /// CHECK: pool state, pinned to amm_state.cpmm_pool_state in the handler
    pub cpmm_pool_state: Option<AccountInfo<'info>>,
    /// CHECK: pool observation (TWAP ring)
    pub cpmm_observation: Option<AccountInfo<'info>>,
    /// CHECK: pool USDC vault (quote leg)
    pub cpmm_input_vault: Option<AccountInfo<'info>>,
    /// CHECK: pool AFHO vault (base leg)
    pub cpmm_output_vault: Option<AccountInfo<'info>>,

    /// Market status PDA — same gate as the USDC path.
    /// CHECK: seeds-verified against the crank program stored at init
    #[account(
        seeds = [b"market_status"],
        seeds::program = amm_state.crank_program,
        bump
    )]
    pub market_status: UncheckedAccount<'info>,

    /// 80% — USDC buyback vault (also the SOL→USDC swap output)
    #[account(mut, address = amm_state.usdc_vault)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// 10% — USDC dip reserve
    #[account(mut, address = amm_state.usdc_dip)]
    pub usdc_dip: Box<InterfaceAccount<'info, TokenAccount>>,
    /// 10% — staker rewards holding vault (USDC)
    #[account(mut, address = amm_state.usdc_rewards)]
    pub usdc_rewards: Box<InterfaceAccount<'info, TokenAccount>>,

    // --- wSOL wrap + SOL/USDC swap (All-USDC conversion) ---
    /// CHECK: wSOL ATA owned by amm_state — lamports land here, then sync_native
    #[account(mut)]
    pub wsol_vault: UncheckedAccount<'info>,
    /// wSOL mint (So1111...)
    pub wrapped_sol_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: SOL/USDC CPMM pool state PDA
    #[account(mut)]
    pub sol_usdc_pool_state: UncheckedAccount<'info>,
    /// CHECK: SOL/USDC amm_config
    pub sol_usdc_amm_config: UncheckedAccount<'info>,
    /// CHECK: pool wSOL vault
    #[account(mut)]
    pub sol_usdc_input_vault: UncheckedAccount<'info>,
    /// CHECK: pool USDC vault
    #[account(mut)]
    pub sol_usdc_output_vault: UncheckedAccount<'info>,
    /// CHECK: pool observation
    #[account(mut)]
    pub sol_usdc_observation: UncheckedAccount<'info>,
    /// CHECK: pool authority PDA
    pub sol_usdc_authority: UncheckedAccount<'info>,

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

    /// Classic SPL (wSOL + USDC legs)
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
    /// Token-2022 (AFHO leg into staking)
    pub token_2022_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler_sol(ctx: Context<OfferClaimSol>, tier: u8, units: u8, index: u64) -> Result<()> {
    let clock = Clock::get()?;
    let (cpmm_pool_state, cpmm_program, cpmm_sol_usdc_pool) = {
        let a = &ctx.accounts.amm_state;
        (a.cpmm_pool_state, a.cpmm_program, a.cpmm_sol_usdc_pool)
    };
    let pinned = cpmm_pool_state != Pubkey::default();
    let sol_pinned = cpmm_sol_usdc_pool != Pubkey::default();

    // AFHO/USDC spot-price accounts (pinned when configured).
    require_pinned_pricing_accounts(
        pinned,
        cpmm_program,
        cpmm_pool_state,
        &ctx.accounts.afho_mint.key(),
        &ctx.accounts.usdc_mint.key(),
        ctx.accounts.cpmm_pool_state.as_ref(),
        ctx.accounts.cpmm_observation.as_ref(),
        ctx.accounts.cpmm_output_vault.as_ref(),
        ctx.accounts.cpmm_input_vault.as_ref(),
    )?;
    // SOL/USDC swap accounts (pinned when the pool is configured).
    require!(
        super::raydium::pinned_sol_usdc_accounts_valid(
            sol_pinned,
            cpmm_program,
            cpmm_sol_usdc_pool,
            ctx.accounts.amm_state.cpmm_sol_usdc_config,
            ctx.accounts.wrapped_sol_mint.key(),
            ctx.accounts.usdc_mint.key(),
            &ctx.accounts.sol_usdc_pool_state.to_account_info(),
            &ctx.accounts.sol_usdc_amm_config.to_account_info(),
            &ctx.accounts.sol_usdc_input_vault.to_account_info(),
            &ctx.accounts.sol_usdc_output_vault.to_account_info(),
            &ctx.accounts.sol_usdc_observation.to_account_info(),
            &ctx.accounts.sol_usdc_authority.to_account_info(),
        ),
        ErrorCode::InvalidPoolAccount
    );

    let live_price = if pinned {
        super::raydium::read_cpmm_price_floor(
            ctx.accounts.cpmm_pool_state.as_ref().unwrap(),
            ctx.accounts.cpmm_observation.as_ref().unwrap(),
            ctx.accounts.cpmm_output_vault.as_ref().unwrap(),
            ctx.accounts.cpmm_input_vault.as_ref().unwrap(),
            &ctx.accounts.afho_mint.key(),
            &ctx.accounts.usdc_mint.key(),
            clock.unix_timestamp as u64,
        )
        .ok_or(ErrorCode::InvalidOracle)?
    } else {
        read_live_price(ctx.accounts.spot_oracle.as_ref().ok_or(ErrorCode::InvalidOracle)?)?
    };

    let q = quote_claim(
        &ctx.accounts.market_status,
        &ctx.accounts.offer_list,
        &ctx.accounts.amm_state,
        ctx.accounts.afho_mint.decimals,
        live_price,
        tier,
        units,
    )?;

    // ── Convert the USDC-denominated cost into lamports ──
    // sol_price units match the spot oracle: (usdc_raw x 1e6) / lamports,
    // so lamports = cost_usdc x 1e6 / sol_price. The CPMM charges a 0.25%
    // fee on the input leg, so the buyer is charged 25bps on top — the pool
    // then nets the protocol the full USDC cost (min-out below guards the
    // residual slippage/drift).
    let sol_price = if sol_pinned {
        super::raydium::read_cpmm_price_floor(
            &ctx.accounts.sol_usdc_pool_state.to_account_info(),
            &ctx.accounts.sol_usdc_observation.to_account_info(),
            &ctx.accounts.sol_usdc_input_vault.to_account_info(),  // wSOL (base)
            &ctx.accounts.sol_usdc_output_vault.to_account_info(), // USDC (quote)
            &ctx.accounts.wrapped_sol_mint.key(),
            &ctx.accounts.usdc_mint.key(),
            clock.unix_timestamp as u64,
        )
        .ok_or(ErrorCode::InvalidOracle)?
    } else {
        read_live_price(ctx.accounts.sol_oracle.as_ref().ok_or(ErrorCode::InvalidOracle)?)?
    };
    require!(sol_price > 0, ErrorCode::InvalidOracle);
    let lamports = (q.cost_usdc as u128)
        .checked_mul(1_000_000u128)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_mul(10_025u128)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(sol_price as u128)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(10_000u128)
        .ok_or(ErrorCode::MathOverflow)?;
    let lamports = u64::try_from(lamports).map_err(|_| ErrorCode::MathOverflow)?;
    require!(lamports > 0, ErrorCode::ZeroAmount);

    // ── 0. Ensure the wSOL ATA exists. bounty_top_up closes it after
    //       unwrapping, and nothing else recreates it — without this the
    //       first (or post-top-up) SOL claim would fail. ──
    let mint_key = ctx.accounts.amm_state.afho_mint;
    let state_bump = ctx.accounts.amm_state.bump;
    let seeds: &[&[u8]] = &[b"amm_state", mint_key.as_ref(), &[state_bump]];
    create_idempotent(
        CpiContext::new(
            ctx.accounts.associated_token_program.to_account_info(),
            Create {
                payer: ctx.accounts.buyer.to_account_info(),
                associated_token: ctx.accounts.wsol_vault.to_account_info(),
                authority: ctx.accounts.amm_state.to_account_info(),
                mint: ctx.accounts.wrapped_sol_mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        )
        .with_signer(&[seeds]),
    )?;

    // ── 1. Wrap the buyer's lamports into the wSOL vault ──
    let buyer_key = ctx.accounts.buyer.key();
    anchor_lang::solana_program::program::invoke(
        &anchor_lang::solana_program::system_instruction::transfer(
            &buyer_key,
            &ctx.accounts.wsol_vault.key(),
            lamports,
        ),
        &[
            ctx.accounts.buyer.to_account_info(),
            ctx.accounts.wsol_vault.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;
    sync_native(CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        SyncNative {
            account: ctx.accounts.wsol_vault.to_account_info(),
        },
    ))?;

    // ── 2. Swap wSOL → USDC via the SOL/USDC pool, output into usdc_vault ──
    let mint_key = ctx.accounts.amm_state.afho_mint;
    let state_bump = ctx.accounts.amm_state.bump;
    let cpmm_program = ctx.accounts.amm_state.cpmm_program;
    let seeds: &[&[u8]] = &[b"amm_state", mint_key.as_ref(), &[state_bump]];
    let ix = crate::instructions::raydium::cpmm_swap_base_input_ix(
        cpmm_program,
        ctx.accounts.amm_state.key(),
        ctx.accounts.sol_usdc_authority.key(),
        ctx.accounts.sol_usdc_amm_config.key(),
        ctx.accounts.sol_usdc_pool_state.key(),
        ctx.accounts.wsol_vault.key(),
        ctx.accounts.usdc_vault.key(),
        ctx.accounts.sol_usdc_input_vault.key(),
        ctx.accounts.sol_usdc_output_vault.key(),
        ctx.accounts.token_program.key(),
        ctx.accounts.token_program.key(),
        ctx.accounts.wrapped_sol_mint.key(),
        ctx.accounts.usdc_mint.key(),
        ctx.accounts.sol_usdc_observation.key(),
        lamports,
        q.cost_usdc.saturating_mul(98) / 100, // min-out: 2% tolerance for pool drift/slippage
    );
    anchor_lang::solana_program::program::invoke_signed(
        &ix,
        &[
            ctx.accounts.amm_state.to_account_info(),
            ctx.accounts.sol_usdc_authority.to_account_info(),
            ctx.accounts.sol_usdc_amm_config.to_account_info(),
            ctx.accounts.sol_usdc_pool_state.to_account_info(),
            ctx.accounts.wsol_vault.to_account_info(),
            ctx.accounts.usdc_vault.to_account_info(),
            ctx.accounts.sol_usdc_input_vault.to_account_info(),
            ctx.accounts.sol_usdc_output_vault.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.wrapped_sol_mint.to_account_info(),
            ctx.accounts.usdc_mint.to_account_info(),
            ctx.accounts.sol_usdc_observation.to_account_info(),
        ],
        &[seeds],
    )?;

    // ── 3. 80/10/10 split of the USDC (rounding favors the buyback vault) ──
    let dip = q.cost_usdc / 10;
    let rewards = q.cost_usdc / 10;
    let usdc_decimals = ctx.accounts.usdc_mint.decimals;
    for (to, amount) in [
        (ctx.accounts.usdc_dip.to_account_info(), dip),
        (ctx.accounts.usdc_rewards.to_account_info(), rewards),
    ] {
        if amount == 0 {
            continue;
        }
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.usdc_vault.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to,
                    authority: ctx.accounts.amm_state.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            usdc_decimals,
        )?;
    }

    validate_user_index(&ctx.accounts.user_index.to_account_info(), index)?;
    settle_sheet(&mut ctx.accounts.offer_list, tier, units, q.total_tokens);
    let amm_state = &mut ctx.accounts.amm_state;
    amm_state.total_usdc_proceeds = amm_state.total_usdc_proceeds.saturating_add(q.cost_usdc);

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
        "Claimed {} AFHO ({} lots, tier {}) at {} ({}bps off, floor: {}); paid {} lamports -> {} usdc",
        q.total_tokens,
        units,
        tier,
        q.effective_price,
        q.discount_bps,
        q.floor,
        lamports,
        q.cost_usdc,
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
    live_price: u64,
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
    require!(live_price > 0, ErrorCode::InvalidOracle);
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

/// When the AFHO/USDC CPMM pool is pinned, verify the four pricing accounts
/// (pool state, observation, USDC vault, AFHO vault) are the pool's own
/// derived PDAs. No-op in mock/localnet mode.
#[allow(clippy::too_many_arguments)]
pub(crate) fn require_pinned_pricing_accounts(
    pinned: bool,
    cpmm_program: Pubkey,
    expected_pool_state: Pubkey,
    afho_mint: &Pubkey,
    usdc_mint: &Pubkey,
    acct_pool_state: Option<&AccountInfo>,
    acct_observation: Option<&AccountInfo>,
    acct_base_vault: Option<&AccountInfo>,
    acct_quote_vault: Option<&AccountInfo>,
) -> Result<()> {
    if !pinned {
        return Ok(());
    }
    let pool_state = acct_pool_state.ok_or(ErrorCode::InvalidPoolAccount)?;
    let observation = acct_observation.ok_or(ErrorCode::InvalidPoolAccount)?;
    let base_vault = acct_base_vault.ok_or(ErrorCode::InvalidPoolAccount)?;
    let quote_vault = acct_quote_vault.ok_or(ErrorCode::InvalidPoolAccount)?;
    require!(
        pool_state.key() == expected_pool_state,
        ErrorCode::InvalidPoolAccount
    );
    require!(
        observation.key()
            == crate::instructions::raydium::observation_pda(&cpmm_program, expected_pool_state).0,
        ErrorCode::InvalidPoolAccount
    );
    require!(
        quote_vault.key()
            == crate::instructions::raydium::pool_vault_pda(&cpmm_program, expected_pool_state, *usdc_mint).0,
        ErrorCode::InvalidPoolAccount
    );
    require!(
        base_vault.key()
            == crate::instructions::raydium::pool_vault_pda(&cpmm_program, expected_pool_state, *afho_mint).0,
        ErrorCode::InvalidPoolAccount
    );
    Ok(())
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
    #[msg("CPMM pool account mismatch")]
    InvalidPoolAccount,
}
