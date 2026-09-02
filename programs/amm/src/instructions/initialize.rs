use crate::state::offersState::{AcceptedOffers, AmmState, MarketMetrics, OfferList};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::Token2022,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

pub fn handler(
    ctx: Context<InitializeAmm>,
    spot_oracle: Pubkey,
    staking_pool: Pubkey,
    sol_oracle: Pubkey,
) -> Result<()> {
    // initialize the POSR vault
    // during minting, % of coins will get stored here

    let amm_state = &mut ctx.accounts.amm_state;
    let offer_list = &mut ctx.accounts.offer_list;

    amm_state.authority = ctx.accounts.authority.key();
    // Single-wallet setups (devnet) work out of the box; rotate for mainnet.
    amm_state.keeper = ctx.accounts.authority.key();
    amm_state.afho_mint = ctx.accounts.afho_mint.key();
    amm_state.usdc_mint = ctx.accounts.usdc_mint.key();
    amm_state.sol_vault = ctx.accounts.sol_vault.key();
    amm_state.usdc_vault = ctx.accounts.usdc_vault.key();
    amm_state.sol_dip = ctx.accounts.sol_dip.key();
    amm_state.usdc_dip = ctx.accounts.usdc_dip.key();
    amm_state.afho_vault = ctx.accounts.afho_vault.key();
    amm_state.offer_list = offer_list.key();
    amm_state.accepted_offers = ctx.accounts.accepted_offers.key();
    amm_state.market_status_pda = ctx.accounts.market_status_pda.key();
    amm_state.crank_program = ctx.accounts.crank_program.key();
    amm_state.price_oracle = ctx.accounts.price_oracle.key();
    amm_state.dex_program = ctx.accounts.dex_program.key();
    // Raydium CPMM pool is pinned later via set_cpmm_pool (once the launch
    // pool exists); default(0) keeps the mock adapter active until then.
    amm_state.cpmm_pool_state = Pubkey::default();
    amm_state.cpmm_amm_config = Pubkey::default();
    amm_state.cpmm_program = Pubkey::default();
    amm_state.cpmm_sol_usdc_pool = Pubkey::default();
    amm_state.cpmm_sol_usdc_config = Pubkey::default();
    amm_state.total_sol_proceeds = 0;
    amm_state.total_usdc_proceeds = 0;
    amm_state.highest_buyback_basis = 0;
    // All day-index guards init to u64::MAX, NOT 0: the first trading day IS
    // day 0, and the guards are `stored != current_day` — a 0 init would
    // deadlock make_offers / update_tradeday_stats / calc_completed_offers /
    // distribute_staker_rewards on launch day (L1). u64::MAX never collides
    // with a real day index.
    amm_state.bb_day_index = u64::MAX;
    amm_state.bb_budget_usdc = 0;
    amm_state.bb_spent_usdc = 0;
    amm_state.bb_budget_sol = 0;
    amm_state.bb_spent_sol = 0;
    amm_state.bb_slice_count = 0;
    amm_state.bb_last_slot = 0;
    amm_state.untaken_days = 0;
    amm_state.spot_oracle = spot_oracle;
    amm_state.staking_pool = staking_pool;
    amm_state.usdc_rewards = ctx.accounts.usdc_rewards.key();
    amm_state.rewards_day_index = u64::MAX;
    amm_state.sol_oracle = sol_oracle;
    amm_state.sol_rewards = ctx.accounts.sol_rewards.key();
    amm_state.dip_day_index = u64::MAX;
    amm_state.dip_day_usdc = 0;
    amm_state.dip_day_sol = 0;
    amm_state.dip_spent_usdc = 0;
    amm_state.dip_spent_sol = 0;
    amm_state.dip_last_slot = 0;
    amm_state.dip_slice_count = 0;
    amm_state.sol_dip_bump = ctx.bumps.sol_dip;
    amm_state.bump = ctx.bumps.amm_state;
    amm_state.sol_vault_bump = ctx.bumps.sol_vault;
    amm_state.sol_rewards_bump = ctx.bumps.sol_rewards;

    offer_list.owner = ctx.accounts.authority.key();
    offer_list.seed = 0;
    offer_list.day_index = u64::MAX; // L1: see day-index comment above
    offer_list.total_complete = 0;
    offer_list.bump = ctx.bumps.offer_list;

    let empty_offer = crate::state::offersState::Offer {
        lot_size: 0,
        vesting_days: 0,
        discount_bps: 0,
        _pad: 0,
        remaining: 0,
        total_offered: 0,
    };
    offer_list.big_offer = empty_offer;
    offer_list.med_offer = empty_offer;
    offer_list.sml_offer = empty_offer;

    let accepted_offers = &mut ctx.accounts.accepted_offers;
    accepted_offers.day_index = u64::MAX; // L1
    accepted_offers.big_offers_accepted = [0; 5];
    accepted_offers.med_offers_accepted = [0; 5];
    accepted_offers.sml_offers_accepted = [0; 5];

    let metrics = &mut ctx.accounts.metrics;
    metrics.day_index = u64::MAX; // L1
    metrics.price_changes = [0; 20];
    metrics.sample_head = 0;
    metrics.treasury_sol = 0;
    metrics.total_staked = 0;
    metrics.total_supply = 0;
    metrics.trailing_stake_health = [0; 5];
    metrics.spot_prices = [0; 32];
    metrics.spot_head = 0;
    metrics.spot_last_slot = 0;

    // Fund the three space-0 SOL holding PDAs with the rent-exempt minimum.
    // The system transfer creates them system-owned with NO data. The SOL
    // legs these PDAs once funded are retired (USDC-only swaps) — the PDAs
    // remain until the §4 state-field cleanup lands.
    let sol_rent = Rent::get()?.minimum_balance(0);
    for info in [
        ctx.accounts.sol_dip.to_account_info(),
        ctx.accounts.sol_vault.to_account_info(),
        ctx.accounts.sol_rewards.to_account_info(),
    ] {
        if info.lamports() < sol_rent {
            anchor_lang::solana_program::program::invoke(
                &anchor_lang::solana_program::system_instruction::transfer(
                    &ctx.accounts.authority.key(),
                    &info.key(),
                    sol_rent - info.lamports(),
                ),
                &[
                    ctx.accounts.authority.to_account_info(),
                    info,
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;
        }
    }
    msg!(
        "did initialize the AMM empty state for mint {}",
        amm_state.afho_mint
    );
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeAmm<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub afho_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        payer=authority,
        seeds=[b"amm_state", afho_mint.key().as_ref()],
        bump,
        space = 8 + std::mem::size_of::<AmmState>(),
    )]
    pub amm_state: Box<Account<'info, AmmState>>,
    /// CHECK: afho vault
    #[account(
        associated_token::mint = afho_mint,
        associated_token::authority = amm_state,
        associated_token::token_program = token_2022_program,
    )]
    pub afho_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: usdc vault
    #[account(
       associated_token::mint = usdc_mint,
        associated_token::authority = amm_state,
        associated_token::token_program = token_program,
    )]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// 10% — dip reserve. PDA-derived token account, NOT an ATA: the ATA of
    /// (usdc_mint, amm_state) IS usdc_vault, so "three ATAs" would be one
    /// account and the 80/10/10 split would collapse into it.
    #[account(
        init,
        payer = authority,
        seeds = [b"amm_usdc_dip", afho_mint.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = amm_state,
        token::token_program = token_program,
    )]
    pub usdc_dip: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Holding vault for the stakers' 10% USDC share (same PDA-token pattern
    /// as usdc_dip — distinct address from usdc_vault by construction)
    #[account(
        init,
        payer = authority,
        seeds = [b"amm_usdc_rewards", afho_mint.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = amm_state,
        token::token_program = token_program,
    )]
    pub usdc_rewards: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: SOL dip reserve (system PDA, seeds [b"amm_sol_dip", mint]).
    /// Space-0, system-owned — a data-carrying or program-owned account
    /// fails outbound system transfers ("Transfer: from must not carry
    /// data"). Funded with rent-exempt minimum in the handler below.
    #[account(mut, seeds = [b"amm_sol_dip", afho_mint.key().as_ref()], bump)]
    pub sol_dip: AccountInfo<'info>,
    /// CHECK: SOL buyback vault (same space-0 system-PDA pattern)
    #[account(mut, seeds = [b"amm_sol_vault", afho_mint.key().as_ref()], bump)]
    pub sol_vault: AccountInfo<'info>,
    /// CHECK: holding PDA for the stakers' 10% share of SOL proceeds (same)
    #[account(mut, seeds = [b"amm_sol_rewards", afho_mint.key().as_ref()], bump)]
    pub sol_rewards: AccountInfo<'info>,
    #[account(
        init,
        payer = authority,
        seeds = [b"offer_list", afho_mint.key().as_ref()],
        bump,
        space = 8 + std::mem::size_of::<OfferList>(),
    )]
    pub offer_list: Box<Account<'info, OfferList>>,
    #[account(
        init,
        payer = authority,
        seeds = [b"accepted_offers", afho_mint.key().as_ref()],
        bump,
        space = 8 + std::mem::size_of::<AcceptedOffers>(),
    )]
    pub accepted_offers: Box<Account<'info, AcceptedOffers>>,
    #[account(
        init,
        payer = authority,
        seeds = [b"metrics", afho_mint.key().as_ref()],
        bump,
        space = 8 + std::mem::size_of::<MarketMetrics>(),
    )]
    pub metrics: Box<Account<'info, MarketMetrics>>,

    /// CHECK: verfiy seeds derive against crank
    #[account(
        seeds = [b"market_status"],
        bump,
        seeds::program = crank_program,
    )]
    pub market_status_pda: UncheckedAccount<'info>,

    /// CHECK: stored for verification in makeOffers
    pub crank_program: AccountInfo<'info>,
    /// CHECK: legacy Switchboard quote slot — pinned in state but no longer
    /// read (momentum comes from the self-sampled pool price ring)
    pub price_oracle: AccountInfo<'info>,
    /// CHECK: swap target for dex_buyback (mock-dex-pool stub on devnet; the
    /// real DEX pool program at launch)
    pub dex_program: AccountInfo<'info>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}