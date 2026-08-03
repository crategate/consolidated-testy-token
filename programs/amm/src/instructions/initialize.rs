use crate::state::offersState::{AcceptedOffers, AmmState, MarketMetrics, OfferList};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::Token2022,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

pub fn handler(ctx: Context<InitializeAmm>) -> Result<()> {
    // initialize the POSR vault
    // during minting, % of coins will get stored here

    let amm_state = &mut ctx.accounts.amm_state;
    let offer_list = &mut ctx.accounts.offer_list;

    amm_state.authority = ctx.accounts.authority.key();
    // Single-wallet setups (devnet) work out of the box; rotate for mainnet.
    amm_state.keeper = ctx.accounts.authority.key();
    amm_state.nyseh_mint = ctx.accounts.nyseh_mint.key();
    amm_state.usdc_mint = ctx.accounts.usdc_mint.key();
    amm_state.sol_vault = ctx.accounts.sol_vault.key();
    amm_state.usdc_vault = ctx.accounts.usdc_vault.key();
    amm_state.nyseh_vault = ctx.accounts.nyseh_vault.key();
    amm_state.offer_list = offer_list.key();
    amm_state.accepted_offers = ctx.accounts.accepted_offers.key();
    amm_state.market_status_pda = ctx.accounts.market_status_pda.key();
    amm_state.crank_program = ctx.accounts.crank_program.key();
    amm_state.price_oracle = ctx.accounts.price_oracle.key();
    amm_state.total_sol_proceeds = 0;
    amm_state.total_usdc_proceeds = 0;
    amm_state.bump = ctx.bumps.amm_state;
    amm_state.sol_vault_bump = ctx.bumps.sol_vault;

    offer_list.owner = ctx.accounts.authority.key();
    offer_list.seed = 0;
    offer_list.day_index = 0;
    offer_list.total_complete = 0;
    offer_list.bump = ctx.bumps.offer_list;

    let empty_offer = crate::state::offersState::Offer {
        lot_size: 0,
        vesting_days: 0,
        discount_bps: 0,
        remaining: 0,
        total_offered: 0,
    };
    offer_list.big_offer = empty_offer;
    offer_list.med_offer = empty_offer;
    offer_list.sml_offer = empty_offer;

    let accepted_offers = &mut ctx.accounts.accepted_offers;
    accepted_offers.day_index = 0;
    accepted_offers.big_offers_accepted = [0; 5];
    accepted_offers.med_offers_accepted = [0; 5];
    accepted_offers.sml_offers_accepted = [0; 5];

    let metrics = &mut ctx.accounts.metrics;
    metrics.day_index = 0;
    metrics.price_changes = [0; 20];
    metrics.sample_head = 0;
    metrics.treasury_sol = 0;
    metrics.total_staked = 0;
    metrics.total_supply = 0;
    metrics.trailing_stake_health = [0; 5];
    msg!(
        "did initialize the AMM empty state for mint {}",
        amm_state.nyseh_mint
    );
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeAmm<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub nyseh_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        payer=authority,
        seeds=[b"amm_state", nyseh_mint.key().as_ref()],
        bump,
        space = 8 + AmmState::INIT_SPACE,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,
    /// CHECK: nyseh vault
    #[account(
        associated_token::mint = nyseh_mint,
        associated_token::authority = amm_state,
        associated_token::token_program = token_2022_program,
    )]
    pub nyseh_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: usdc vault
    #[account(
       associated_token::mint = usdc_mint,
        associated_token::authority = amm_state,
        associated_token::token_program = token_program,
    )]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        associated_token::mint = usdc_mint,
        associated_token::authority = amm_state,
        associated_token::token_program = token_program,
    )]
    pub usdc_dip: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: sol vault for buybacks on dips
    #[account(
        init,
        payer = authority,
        seeds = [b"amm_sol_dip", nyseh_mint.key().as_ref()],
        bump,
        space = 8,
    )]
    pub sol_dip: AccountInfo<'info>,
    /// CHECK: sol vault pda to hold sol
    #[account(
        init,
        payer = authority,
        seeds = [b"amm_sol_vault", nyseh_mint.key().as_ref()],
        bump,
        space = 8,
    )]
    pub sol_vault: AccountInfo<'info>,
    #[account(
        init,
        payer = authority,
        seeds = [b"offer_list", nyseh_mint.key().as_ref()],
        bump,
        space = 8 + OfferList::INIT_SPACE,
    )]
    pub offer_list: Account<'info, OfferList>,
    #[account(
        init,
        payer = authority,
        seeds = [b"accepted_offers", nyseh_mint.key().as_ref()],
        bump,
        space = 8 + AcceptedOffers::INIT_SPACE,
    )]
    pub accepted_offers: Account<'info, AcceptedOffers>,
    #[account(
        init,
        payer = authority,
        seeds = [b"metrics", nyseh_mint.key().as_ref()],
        bump,
        space = 8 + MarketMetrics::INIT_SPACE,
    )]
    pub metrics: Account<'info, MarketMetrics>,

    /// CHECK: verfiy seeds derive against crank
    #[account(
        seeds = [b"market_status"],
        bump,
        seeds::program = crank_program,
    )]
    pub market_status_pda: UncheckedAccount<'info>,

    /// CHECK: stored for verification in makeOffers
    pub crank_program: AccountInfo<'info>,
    /// CHECK: canonical Switchboard quote account for [market_status, price] feeds
    pub price_oracle: AccountInfo<'info>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}
