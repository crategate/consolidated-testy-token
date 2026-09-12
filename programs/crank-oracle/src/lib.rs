//! AFHO market-status crank oracle — native `solana-program` build (no
//! anchor-lang dependency).
//!
//! Wire-compatible with the anchor 0.31 IDL previously published for this
//! program: instruction discriminators, account discriminators, account
//! layouts, PDA seeds/bumps, and error codes are byte-identical, so the
//! existing TS clients (`mev-keeper.ts`, `mev-keeper-mainnet.ts`,
//! `scripts/init-bounty.ts`, `fund-bounty.ts`, `set-bounty-usd.ts`,
//! `tests/staking.test.ts`, …) work unchanged.
//!
//! The Switchboard quote account is parsed with the vendored
//! `ParsedEd25519Instruction` layout parser — the same code path the previous
//! anchor build used via the vendored `AccountDeserialize`, so on-chain
//! semantics are preserved exactly.
//!
//! See docs/DEPLOY-COST-REDUCTION.md (lever D) for the size/rent motivation.

use solana_program::{
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program::invoke,
    program_error::ProgramError,
    pubkey::Pubkey,
    system_instruction,
    sysvar::{clock::Clock, rent::Rent, Sysvar, SysvarId},
};
use switchboard_on_demand::prelude::rust_decimal::prelude::ToPrimitive;
use switchboard_on_demand::{ParsedEd25519Instruction, QUOTE_PROGRAM_ID};

pub const ID: Pubkey = solana_program::pubkey!("HkA18DxZU3RSg2cJfC1vZEkkRmDnSWuXjHim2NXbao7U");

const SEED_BOUNTY_CONFIG: &[u8] = b"bounty_config";
const SEED_BOUNTY_VAULT: &[u8] = b"bounty_vault";
const SEED_MARKET_STATUS: &[u8] = b"market_status";
const POOL_VAULT_SEED: &[u8] = b"pool_vault";
const WSOL_MINT: Pubkey = solana_program::pubkey!("So11111111111111111111111111111111111111112");

// ─────────────────────────── IDL discriminator bytes ────────────────────────
// Extracted from target/idl/crank_oracle.json (anchor 0.31: the TS client
// uses these raw bytes, not a computed sighash). Anchor instruction
// discriminators are sha256("global:<name>")[..8]; account discriminators are
// sha256("account:<Name>")[..8]. DO NOT reorder or rename without regenerating
// the IDL.
const DISC_INITIALIZE_BOUNTY: [u8; 8] = [0x96, 0x25, 0xf9, 0xf6, 0x55, 0xa4, 0xfd, 0xe5];
const DISC_FUND_BOUNTY: [u8; 8] = [0x24, 0x94, 0x8b, 0xef, 0xac, 0x25, 0x3a, 0xff];
const DISC_PERMISSIONLESS_CRANK: [u8; 8] = [0xf1, 0x23, 0x44, 0x48, 0x15, 0xaa, 0x59, 0x7f];
const DISC_READ_ORACLE_DATA: [u8; 8] = [0x51, 0x67, 0xf2, 0x0c, 0xcc, 0x63, 0x52, 0xea];
const DISC_INITIALIZE_STATE: [u8; 8] = [0xbe, 0xab, 0xe0, 0xdb, 0xd9, 0x48, 0xc7, 0xb0];
const DISC_SET_AUTHORITY: [u8; 8] = [0x85, 0xfa, 0x25, 0x15, 0x6e, 0xa3, 0x1a, 0x79];
const DISC_SET_BOUNTY_AMOUNT: [u8; 8] = [0xa6, 0x12, 0xa9, 0x0c, 0xa6, 0xfa, 0x6f, 0xd7];
const DISC_SET_BOUNTY_USD: [u8; 8] = [0x33, 0x3c, 0x12, 0x3c, 0x28, 0xce, 0x61, 0x3f];
const DISC_TEST_COLLECT_BOUNTY: [u8; 8] = [0xfb, 0xce, 0xa7, 0x05, 0xf7, 0x4a, 0x14, 0xfa];
const DISC_TEST_SET_STATE: [u8; 8] = [0x61, 0x77, 0xc2, 0xc5, 0x8d, 0x25, 0x22, 0x1b];
const DISC_MARKET_STATUS: [u8; 8] = [0x65, 0x2b, 0x7f, 0xc9, 0x64, 0xdd, 0xd0, 0xbc];
const DISC_BOUNTY_CONFIG: [u8; 8] = [0x83, 0xc9, 0x1c, 0x22, 0x46, 0xc6, 0x56, 0xbd];

// ────────────────────────────── error codes ─────────────────────────────────
// anchor custom errors: 6000 + CrankError enum index. The IDL maps these back
// to names (NoFeeds, InvalidFeedValue, …) on the TS side.
const ERR_NO_FEEDS: u32 = 6000;
const ERR_INVALID_FEED_VALUE: u32 = 6001;
const ERR_INVALID_MARKET_STATE: u32 = 6002;
const ERR_INVALID_AUTHORITY: u32 = 6003;
const ERR_QUOTE_TOO_STALE: u32 = 6004;
const ERR_STALE_QUOTE: u32 = 6005;
const ERR_BOUNTY_EXHAUSTED: u32 = 6006;
const ERR_INVALID_SOL_PRICE: u32 = 6007;
const ERR_MATH_OVERFLOW: u32 = 6008;

fn err(code: u32) -> ProgramError {
    ProgramError::Custom(code)
}

// ─────────────────────────── account layouts ────────────────────────────────
// Byte-identical to the anchor borsh layouts (8-byte discriminator + fields,
// all fixed-size LE — borsh adds no padding for these types).
//
// MarketStatus: disc(8) + current_state(1) + last_updated_timestamp(8)
//               + trading_day_index(8) = 25 bytes (anchor allocates 40).
#[derive(Clone, Copy)]
struct MarketStatus {
    state: u8,
    last_updated_timestamp: i64,
    trading_day_index: u64,
}

fn read_market_status(ai: &solana_program::account_info::AccountInfo) -> Result<MarketStatus, ProgramError> {
    let data = ai.try_borrow_data()?;
    if data.len() < 25 || data[..8] != DISC_MARKET_STATUS {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(MarketStatus {
        state: data[8],
        last_updated_timestamp: i64::from_le_bytes(data[9..17].try_into().unwrap()),
        trading_day_index: u64::from_le_bytes(data[17..25].try_into().unwrap()),
    })
}

fn write_market_status(ai: &solana_program::account_info::AccountInfo, m: &MarketStatus) -> Result<(), ProgramError> {
    let mut data = ai.try_borrow_mut_data()?;
    if data.len() < 25 {
        return Err(ProgramError::InvalidAccountData);
    }
    data[..8].copy_from_slice(&DISC_MARKET_STATUS);
    data[8] = m.state;
    data[9..17].copy_from_slice(&m.last_updated_timestamp.to_le_bytes());
    data[17..25].copy_from_slice(&m.trading_day_index.to_le_bytes());
    Ok(())
}

/// BountyConfig: disc(8) + authority(32) + bounty_amount(8) + bounty_usd_raw(8)
/// + base_year(2) + annual_inflation_bps(2) + last_crank_slot(8)
/// + sol_usdc_pool(32) + cpmm_program(32) + usdc_mint(32) + bump(1) = 165.
#[derive(Clone, Copy)]
struct BountyConfig {
    authority: Pubkey,
    bounty_amount: u64,
    bounty_usd_raw: u64,
    base_year: u16,
    annual_inflation_bps: u16,
    last_crank_slot: u64,
    sol_usdc_pool: Pubkey,
    cpmm_program: Pubkey,
    usdc_mint: Pubkey,
    bump: u8,
}

const BOUNTY_CONFIG_SPACE: u64 = 165;

fn read_bounty_config(ai: &solana_program::account_info::AccountInfo) -> Result<BountyConfig, ProgramError> {
    let data = ai.try_borrow_data()?;
    if data.len() < BOUNTY_CONFIG_SPACE as usize || data[..8] != DISC_BOUNTY_CONFIG {
        return Err(ProgramError::InvalidAccountData);
    }
    let pk = |r: std::ops::Range<usize>| Pubkey::new_from_array(data[r].try_into().unwrap());
    Ok(BountyConfig {
        authority: pk(8..40),
        bounty_amount: u64::from_le_bytes(data[40..48].try_into().unwrap()),
        bounty_usd_raw: u64::from_le_bytes(data[48..56].try_into().unwrap()),
        base_year: u16::from_le_bytes(data[56..58].try_into().unwrap()),
        annual_inflation_bps: u16::from_le_bytes(data[58..60].try_into().unwrap()),
        last_crank_slot: u64::from_le_bytes(data[60..68].try_into().unwrap()),
        sol_usdc_pool: pk(68..100),
        cpmm_program: pk(100..132),
        usdc_mint: pk(132..164),
        bump: data[164],
    })
}

fn write_bounty_config(ai: &solana_program::account_info::AccountInfo, c: &BountyConfig) -> Result<(), ProgramError> {
    let mut data = ai.try_borrow_mut_data()?;
    if data.len() < BOUNTY_CONFIG_SPACE as usize {
        return Err(ProgramError::InvalidAccountData);
    }
    data[..8].copy_from_slice(&DISC_BOUNTY_CONFIG);
    data[8..40].copy_from_slice(c.authority.as_ref());
    data[40..48].copy_from_slice(&c.bounty_amount.to_le_bytes());
    data[48..56].copy_from_slice(&c.bounty_usd_raw.to_le_bytes());
    data[56..58].copy_from_slice(&c.base_year.to_le_bytes());
    data[58..60].copy_from_slice(&c.annual_inflation_bps.to_le_bytes());
    data[60..68].copy_from_slice(&c.last_crank_slot.to_le_bytes());
    data[68..100].copy_from_slice(c.sol_usdc_pool.as_ref());
    data[100..132].copy_from_slice(c.cpmm_program.as_ref());
    data[132..164].copy_from_slice(c.usdc_mint.as_ref());
    data[164] = c.bump;
    Ok(())
}

// ────────────────────────── switchboard quote view ──────────────────────────
/// On-chain quote layout (vendored SBOD `AccountDeserialize`): b"SBOracle"
/// (8) + queue (32) + u16-LE blob length + blob (ED25519 instruction data);
/// the blob suffix carries slot (8) + version (1) + b"SBOD" (4).
struct QuoteView {
    queue: Pubkey,
    slot: u64,
    feed_ids: Vec<[u8; 32]>,
    feed_values: Vec<switchboard_on_demand::PackedFeedInfo>,
}

fn read_quote(ai: &solana_program::account_info::AccountInfo) -> Result<QuoteView, ProgramError> {
    let data = ai.try_borrow_data()?;
    if data.len() < 44 || &data[..8] != b"SBOracle" {
        return Err(ProgramError::InvalidAccountData);
    }
    let queue = Pubkey::new_from_array(data[8..40].try_into().unwrap());
    let len = u16::from_le_bytes([data[40], data[41]]) as usize;
    if data.len() < 42 + len {
        return Err(ProgramError::InvalidAccountData);
    }
    let parsed = ParsedEd25519Instruction::parse(&data[42..42 + len])
        .map_err(|_| ProgramError::InvalidAccountData)?;
    let feed_ids = parsed.feeds.iter().map(|f| f.feed_id).collect();
    Ok(QuoteView {
        queue,
        slot: parsed.slot,
        feed_ids,
        feed_values: parsed.feeds,
    })
}

/// The quote account must be the canonical SBOD PDA for its feeds:
/// seeds = [queue, feed_id_0, feed_id_1, …] over QUOTE_PROGRAM_ID.
fn quote_is_canonical(queue: &Pubkey, feed_ids: &[[u8; 32]], key: &Pubkey) -> bool {
    let mut seeds: Vec<&[u8]> = Vec::with_capacity(feed_ids.len() + 1);
    seeds.push(queue.as_ref());
    for id in feed_ids {
        seeds.push(id.as_slice());
    }
    let (expected, _) = Pubkey::find_program_address(&seeds, &QUOTE_PROGRAM_ID);
    expected == *key
}

// ────────────────────────────── PDA helpers ─────────────────────────────────
fn canonical_pda(seed: &[u8]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[seed], &ID)
}

/// anchor `seeds = [seed], bump = <stored bump>` — derive with the stored bump
/// (create_program_address rejects non-canonical bumps, same as anchor).
fn check_pda_stored(ai: &solana_program::account_info::AccountInfo, seed: &[u8], bump: u8) -> Result<(), ProgramError> {
    let key = Pubkey::create_program_address(&[seed, &[bump]], &ID)
        .map_err(|_| ProgramError::InvalidSeeds)?;
    if ai.key != &key {
        return Err(ProgramError::InvalidSeeds);
    }
    Ok(())
}

fn check_pda_canonical(ai: &solana_program::account_info::AccountInfo, seed: &[u8]) -> Result<(), ProgramError> {
    let (key, _) = canonical_pda(seed);
    if ai.key != &key {
        return Err(ProgramError::InvalidSeeds);
    }
    Ok(())
}

// ────────────────────────────── arg decoding ────────────────────────────────
fn take<const N: usize>(b: &mut &[u8]) -> Result<[u8; N], ProgramError> {
    if b.len() < N {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (head, rest) = b.split_at(N);
    *b = rest;
    Ok(head.try_into().unwrap())
}

fn finish(b: &[u8]) -> Result<(), ProgramError> {
    if b.is_empty() {
        Ok(())
    } else {
        Err(ProgramError::InvalidInstructionData)
    }
}

fn arg_u64(b: &mut &[u8]) -> Result<u64, ProgramError> {
    Ok(u64::from_le_bytes(take(b)?))
}
fn arg_u16(b: &mut &[u8]) -> Result<u16, ProgramError> {
    Ok(u16::from_le_bytes(take(b)?))
}
fn arg_u8(b: &mut &[u8]) -> Result<u8, ProgramError> {
    Ok(take::<1>(b)?[0])
}
fn arg_i64(b: &mut &[u8]) -> Result<i64, ProgramError> {
    Ok(i64::from_le_bytes(take(b)?))
}
fn arg_pubkey(b: &mut &[u8]) -> Result<Pubkey, ProgramError> {
    Ok(Pubkey::new_from_array(take(b)?))
}

// ──────────────────────────────── entrypoint ────────────────────────────────
// The anchor entrypoint for the IDL-generation shim (idl_spec) lives in its
// own module, but its `#[no_mangle] entrypoint` symbol would collide with
// this one under `--features idl-build`, so the native entrypoint is gated
// out there. The idl-build variant is never deployed — it only regenerates
// target/idl/crank_oracle.json.
#[cfg(not(feature = "idl-build"))]
entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[solana_program::account_info::AccountInfo],
    ix_data: &[u8],
) -> ProgramResult {
    if program_id != &ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    let disc: [u8; 8] = ix_data
        .get(..8)
        .ok_or(ProgramError::InvalidInstructionData)?
        .try_into()
        .unwrap();
    match disc {
        DISC_INITIALIZE_BOUNTY => initialize_bounty(accounts, &ix_data[8..]),
        DISC_FUND_BOUNTY => fund_bounty(accounts, &ix_data[8..]),
        DISC_PERMISSIONLESS_CRANK => permissionless_crank(accounts, &ix_data[8..]),
        DISC_READ_ORACLE_DATA => read_oracle_data(accounts, &ix_data[8..]),
        DISC_INITIALIZE_STATE => initialize_state(accounts, &ix_data[8..]),
        DISC_SET_AUTHORITY => set_authority(accounts, &ix_data[8..]),
        DISC_SET_BOUNTY_AMOUNT => set_bounty_amount(accounts, &ix_data[8..]),
        DISC_SET_BOUNTY_USD => set_bounty_usd(accounts, &ix_data[8..]),
        DISC_TEST_COLLECT_BOUNTY => test_collect_bounty(accounts, &ix_data[8..]),
        DISC_TEST_SET_STATE => test_set_state(accounts, &ix_data[8..]),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

// ─────────────────────────────── handlers ───────────────────────────────────
fn create_pda_account<'a>(
    payer: &solana_program::account_info::AccountInfo<'a>,
    target: &solana_program::account_info::AccountInfo<'a>,
    system: &solana_program::account_info::AccountInfo<'a>,
    space: u64,
    signer_seeds: &[&[u8]],
) -> Result<(), ProgramError> {
    let lamports = Rent::get()?.minimum_balance(space as usize);
    // solana-system-interface marks the `to` account as a SIGNER meta (Agave
    // 2.2+ PDA creation hardening), so PDA creates must be invoke_signed with
    // the target's seeds — plain invoke fails with PrivilegeEscalation.
    solana_program::program::invoke_signed(
        &system_instruction::create_account(payer.key, target.key, lamports, space, &ID),
        &[payer.clone(), target.clone(), system.clone()],
        &[signer_seeds],
    )
}

fn require_signer(ai: &solana_program::account_info::AccountInfo) -> Result<(), ProgramError> {
    if !ai.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    Ok(())
}

fn require_key(ai: &solana_program::account_info::AccountInfo, key: &Pubkey) -> Result<(), ProgramError> {
    if ai.key != key {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

fn initialize_bounty(accounts: &[solana_program::account_info::AccountInfo], args: &[u8]) -> ProgramResult {
    if accounts.len() != 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (payer, rest) = accounts.split_at(1);
    let (bounty_config_ai, rest) = rest.split_at(1);
    let (bounty_vault_ai, rest) = rest.split_at(1);
    let system = &rest[0];
    require_signer(&payer[0])?;
    require_key(system, &solana_program::system_program::id())?;

    let mut b = args;
    let bounty_amount = arg_u64(&mut b)?;
    let bounty_usd_raw = arg_u64(&mut b)?;
    let base_year = arg_u16(&mut b)?;
    let annual_inflation_bps = arg_u16(&mut b)?;
    let sol_usdc_pool = arg_pubkey(&mut b)?;
    let cpmm_program = arg_pubkey(&mut b)?;
    let usdc_mint = arg_pubkey(&mut b)?;
    finish(b)?;

    check_pda_canonical(&bounty_config_ai[0], SEED_BOUNTY_CONFIG)?;
    check_pda_canonical(&bounty_vault_ai[0], SEED_BOUNTY_VAULT)?;
    let (_, cfg_bump) = canonical_pda(SEED_BOUNTY_CONFIG);
    let (_, vault_bump) = canonical_pda(SEED_BOUNTY_VAULT);

    create_pda_account(
        &payer[0],
        &bounty_config_ai[0],
        system,
        BOUNTY_CONFIG_SPACE,
        &[SEED_BOUNTY_CONFIG, &[cfg_bump]],
    )?;
    create_pda_account(
        &payer[0],
        &bounty_vault_ai[0],
        system,
        1,
        &[SEED_BOUNTY_VAULT, &[vault_bump]],
    )?;

    write_bounty_config(
        &bounty_config_ai[0],
        &BountyConfig {
            authority: *payer[0].key,
            bounty_amount,
            bounty_usd_raw,
            base_year,
            annual_inflation_bps,
            last_crank_slot: 0,
            sol_usdc_pool,
            cpmm_program,
            usdc_mint,
            bump: cfg_bump,
        },
    )?;
    Ok(())
}

fn fund_bounty(accounts: &[solana_program::account_info::AccountInfo], args: &[u8]) -> ProgramResult {
    if accounts.len() != 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (payer, rest) = accounts.split_at(1);
    let (cfg_ai, rest) = rest.split_at(1);
    let (vault_ai, rest) = rest.split_at(1);
    let system = &rest[0];
    require_signer(&payer[0])?;
    require_key(system, &solana_program::system_program::id())?;

    let mut b = args;
    let amount = arg_u64(&mut b)?;
    finish(b)?;

    let cfg = read_bounty_config(&cfg_ai[0])?;
    check_pda_stored(&cfg_ai[0], SEED_BOUNTY_CONFIG, cfg.bump)?;
    check_pda_canonical(&vault_ai[0], SEED_BOUNTY_VAULT)?;
    if payer[0].key != &cfg.authority {
        return Err(err(ERR_INVALID_AUTHORITY));
    }

    invoke(
        &system_instruction::transfer(payer[0].key, vault_ai[0].key, amount),
        &[payer[0].clone(), vault_ai[0].clone()],
    )?;
    Ok(())
}

fn permissionless_crank(accounts: &[solana_program::account_info::AccountInfo], args: &[u8]) -> ProgramResult {
    finish(args)?;
    // cranker, bounty_config, bounty_vault, quote_account, clock,
    // market_status, sol_usdc_wsol_vault?, sol_usdc_usdc_vault?, system_program
    if accounts.len() < 7 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let cranker = &accounts[0];
    let cfg_ai = &accounts[1];
    let vault_ai = &accounts[2];
    let quote_ai = &accounts[3];
    let clock_ai = &accounts[4];
    let market_ai = &accounts[5];
    let system_ai = &accounts[accounts.len() - 1];
    let opt = &accounts[6..accounts.len() - 1];
    require_signer(cranker)?;
    require_key(clock_ai, &Clock::id())?;
    require_key(system_ai, &solana_program::system_program::id())?;

    let cfg = read_bounty_config(cfg_ai)?;
    check_pda_stored(cfg_ai, SEED_BOUNTY_CONFIG, cfg.bump)?;
    check_pda_canonical(vault_ai, SEED_BOUNTY_VAULT)?;
    check_pda_canonical(market_ai, SEED_MARKET_STATUS)?;

    if quote_ai.owner != &QUOTE_PROGRAM_ID {
        return Err(ProgramError::IllegalOwner);
    }
    let quote = read_quote(quote_ai)?;
    if !quote_is_canonical(&quote.queue, &quote.feed_ids, quote_ai.key) {
        return Err(ProgramError::InvalidAccountData);
    }

    let clock = Clock::get()?;
    let staleness = clock.slot.saturating_sub(quote.slot);
    let max_age = match read_market_status(market_ai)?.state {
        0 | 1 => 100,
        _ => 300,
    };
    if staleness > max_age {
        return Err(err(ERR_QUOTE_TOO_STALE));
    }
    if quote.slot <= cfg.last_crank_slot {
        return Err(err(ERR_STALE_QUOTE));
    }
    if quote.feed_values.is_empty() {
        return Err(err(ERR_NO_FEEDS));
    }
    let market_state = quote.feed_values[0]
        .value()
        .to_u8()
        .ok_or(err(ERR_INVALID_FEED_VALUE))?;
    if market_state > 3 {
        return Err(err(ERR_INVALID_MARKET_STATE));
    }

    let mut market = read_market_status(market_ai)?;
    let old_state = market.state;
    if (old_state == 1 || old_state == 2) && market_state == 0 {
        market.trading_day_index = market.trading_day_index.checked_add(1).unwrap();
        msg!(
            "Market closed. Trading day index: {}",
            market.trading_day_index
        );
    }
    market.state = market_state;

    // Commit cfg.last_crank_slot (anchor writes account mutations on success;
    // all checks below must pass before anything is written).
    let mut cfg_new = cfg;
    cfg_new.last_crank_slot = quote.slot;

    if market_state == old_state {
        msg!(
            "Heartbeat crank (no state change) — no bounty. State: {}",
            market_state
        );
        write_bounty_config(cfg_ai, &cfg_new)?;
        return Ok(());
    }

    // The timestamp marks when the CURRENT STATE began — only a real
    // transition may bump it (dex_buyback reads it as the market-open time
    // for its first-hour slice weighting).
    market.last_updated_timestamp = clock.unix_timestamp;
    write_market_status(market_ai, &market)?;

    // Payout amount. USD-denominated when the SOL/USDC pool is pinned:
    // lamports = (usd_raw × 1e6) / sol_price_floor, where usd_raw is the
    // base bounty escalated 5%/yr (or the configured bps) since base_year.
    // Falls back to the fixed lamport bounty when the pool isn't set.
    let bounty = bounty_lamports(
        &cfg,
        opt.first(),
        opt.get(1),
        clock.unix_timestamp,
    )?;
    if bounty == 0 {
        return Err(err(ERR_INVALID_SOL_PRICE));
    }
    if vault_ai.lamports() < bounty + Rent::get()?.minimum_balance(1) {
        return Err(err(ERR_BOUNTY_EXHAUSTED));
    }

    write_bounty_config(cfg_ai, &cfg_new)?;
    pay_bounty(vault_ai, cranker, bounty)?;
    msg!(
        "Cranked by {}. Bounty paid: {} lamports. State: {}",
        cranker.key,
        bounty,
        market_state
    );
    Ok(())
}

fn read_oracle_data(accounts: &[solana_program::account_info::AccountInfo], args: &[u8]) -> ProgramResult {
    finish(args)?;
    // cranker, bounty_config, quote_account, clock, market_status
    if accounts.len() != 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let cranker = &accounts[0];
    let cfg_ai = &accounts[1];
    let quote_ai = &accounts[2];
    let clock_ai = &accounts[3];
    let market_ai = &accounts[4];
    require_signer(cranker)?;
    require_key(clock_ai, &Clock::id())?;

    let cfg = read_bounty_config(cfg_ai)?;
    check_pda_stored(cfg_ai, SEED_BOUNTY_CONFIG, cfg.bump)?;
    check_pda_canonical(market_ai, SEED_MARKET_STATUS)?;

    if quote_ai.owner != &QUOTE_PROGRAM_ID {
        return Err(ProgramError::IllegalOwner);
    }
    let quote = read_quote(quote_ai)?;
    if !quote_is_canonical(&quote.queue, &quote.feed_ids, quote_ai.key) {
        return Err(ProgramError::InvalidAccountData);
    }

    let clock = Clock::get()?;
    let staleness = clock.slot.saturating_sub(quote.slot);
    let max_age = match read_market_status(market_ai)?.state {
        0 | 1 => 100,
        _ => 300,
    };
    if staleness > max_age {
        return Err(err(ERR_QUOTE_TOO_STALE));
    }
    // This path WRITES market state but never pays, so it must still consume
    // the quote slot: otherwise the same fresh quote could be replayed to burn
    // a transition before the paying cranker sees it.
    if quote.slot <= cfg.last_crank_slot {
        return Err(err(ERR_STALE_QUOTE));
    }
    if quote.feed_values.is_empty() {
        return Err(err(ERR_NO_FEEDS));
    }

    msg!(
        "Feeds: {} | Quote slot: {} | Staleness: {}",
        quote.feed_values.len(),
        quote.slot,
        staleness
    );

    let new_state = quote.feed_values[0]
        .value()
        .to_u8()
        .ok_or(err(ERR_INVALID_FEED_VALUE))?;
    if new_state > 3 {
        return Err(err(ERR_INVALID_MARKET_STATE));
    }

    let mut market = read_market_status(market_ai)?;
    let old_state = market.state;
    if (old_state == 1 || old_state == 2) && new_state == 0 {
        market.trading_day_index = market.trading_day_index.checked_add(1).unwrap();
        msg!(
            "Market closed. Trading day index:   {}",
            market.trading_day_index
        );
    }
    market.state = new_state;
    market.last_updated_timestamp = clock.unix_timestamp;

    let mut cfg_new = cfg;
    cfg_new.last_crank_slot = quote.slot;

    write_market_status(market_ai, &market)?;
    write_bounty_config(cfg_ai, &cfg_new)?;
    msg!(
        "Market state: {} |& Timestamp: {}",
        new_state,
        market.last_updated_timestamp
    );
    Ok(())
}

fn initialize_state(accounts: &[solana_program::account_info::AccountInfo], args: &[u8]) -> ProgramResult {
    finish(args)?;
    // market_status, payer, system_program
    if accounts.len() != 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let market_ai = &accounts[0];
    let payer = &accounts[1];
    let system = &accounts[2];
    require_signer(payer)?;
    require_key(system, &solana_program::system_program::id())?;
    check_pda_canonical(market_ai, SEED_MARKET_STATUS)?;
    let (_, market_bump) = canonical_pda(SEED_MARKET_STATUS);

    create_pda_account(
        payer,
        market_ai,
        system,
        40,
        &[SEED_MARKET_STATUS, &[market_bump]],
    )?;
    write_market_status(
        market_ai,
        &MarketStatus {
            state: 99, // fail-closed sentinel (documented in AGENTS.md)
            last_updated_timestamp: 0,
            trading_day_index: 0,
        },
    )?;
    Ok(())
}

fn set_authority(accounts: &[solana_program::account_info::AccountInfo], args: &[u8]) -> ProgramResult {
    // authority, bounty_config
    if accounts.len() != 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let authority = &accounts[0];
    let cfg_ai = &accounts[1];
    require_signer(authority)?;

    let mut b = args;
    let new_authority = arg_pubkey(&mut b)?;
    finish(b)?;

    let mut cfg = read_bounty_config(cfg_ai)?;
    check_pda_stored(cfg_ai, SEED_BOUNTY_CONFIG, cfg.bump)?;
    if authority.key != &cfg.authority {
        return Err(err(ERR_INVALID_AUTHORITY));
    }
    cfg.authority = new_authority;
    write_bounty_config(cfg_ai, &cfg)?;
    msg!("Bounty authority rotated to: {}", new_authority);
    Ok(())
}

fn set_bounty_amount(accounts: &[solana_program::account_info::AccountInfo], args: &[u8]) -> ProgramResult {
    // authority, bounty_config
    if accounts.len() != 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let authority = &accounts[0];
    let cfg_ai = &accounts[1];
    require_signer(authority)?;

    let mut b = args;
    let new_amount = arg_u64(&mut b)?;
    finish(b)?;

    let mut cfg = read_bounty_config(cfg_ai)?;
    check_pda_stored(cfg_ai, SEED_BOUNTY_CONFIG, cfg.bump)?;
    if authority.key != &cfg.authority {
        return Err(err(ERR_INVALID_AUTHORITY));
    }
    cfg.bounty_amount = new_amount;
    write_bounty_config(cfg_ai, &cfg)?;
    msg!("Bounty fallback amount set to: {}", new_amount);
    Ok(())
}

fn set_bounty_usd(accounts: &[solana_program::account_info::AccountInfo], args: &[u8]) -> ProgramResult {
    // authority, bounty_config
    if accounts.len() != 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let authority = &accounts[0];
    let cfg_ai = &accounts[1];
    require_signer(authority)?;

    let mut b = args;
    let new_usd_raw = arg_u64(&mut b)?;
    finish(b)?;

    let mut cfg = read_bounty_config(cfg_ai)?;
    check_pda_stored(cfg_ai, SEED_BOUNTY_CONFIG, cfg.bump)?;
    if authority.key != &cfg.authority {
        return Err(err(ERR_INVALID_AUTHORITY));
    }
    cfg.bounty_usd_raw = new_usd_raw;
    write_bounty_config(cfg_ai, &cfg)?;
    msg!("USD bounty set to {} usdc raw", new_usd_raw);
    Ok(())
}

// DEVNET/TEST ONLY — remove before mainnet (paired with
// scripts/oracle/set-oracle-state.ts, which refuses non-devnet clusters; the
// instruction itself has no gate and must be deleted alongside it).
fn test_set_state(accounts: &[solana_program::account_info::AccountInfo], args: &[u8]) -> ProgramResult {
    // market_status (no signer, no state bound — devnet tool)
    if accounts.len() != 1 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let market_ai = &accounts[0];
    check_pda_canonical(market_ai, SEED_MARKET_STATUS)?;

    let mut b = args;
    let state = arg_u8(&mut b)?;
    let day = arg_u64(&mut b)?;
    let ts = arg_i64(&mut b)?;
    finish(b)?;

    write_market_status(
        market_ai,
        &MarketStatus {
            state,
            last_updated_timestamp: ts,
            trading_day_index: day,
        },
    )?;
    msg!("Test state set to: {} day {} ts {}", state, day, ts);
    Ok(())
}

// DEVNET/TEST ONLY — remove before mainnet together with test_set_state
// (paired with the keeper's --test-state mode). Pays the standard crank
// bounty (same USD-priced/fixed rules as permissionless_crank) to the caller.
// A drained vault must not fail the call — it pays what the vault can cover
// above its rent floor (possibly 0); bounty_top_up is the refill.
fn test_collect_bounty(accounts: &[solana_program::account_info::AccountInfo], args: &[u8]) -> ProgramResult {
    finish(args)?;
    // cranker, bounty_config, bounty_vault, sol_usdc_wsol_vault?, sol_usdc_usdc_vault?
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let cranker = &accounts[0];
    let cfg_ai = &accounts[1];
    let vault_ai = &accounts[2];
    let opt = &accounts[3..];
    require_signer(cranker)?;

    let cfg = read_bounty_config(cfg_ai)?;
    check_pda_stored(cfg_ai, SEED_BOUNTY_CONFIG, cfg.bump)?;
    check_pda_canonical(vault_ai, SEED_BOUNTY_VAULT)?;

    let bounty = bounty_lamports(
        &cfg,
        opt.first(),
        opt.get(1),
        Clock::get()?.unix_timestamp,
    )?;
    let available = vault_ai
        .lamports()
        .saturating_sub(Rent::get()?.minimum_balance(1));
    let pay = bounty.min(available);
    if pay > 0 {
        pay_bounty(vault_ai, cranker, pay)?;
    }
    msg!("Test bounty collected: {} lamports", pay);
    Ok(())
}

// ──────────────────────────── USD bounty helpers ────────────────────────────
/// Calendar year from a unix timestamp (exact integer civil-date algorithm;
/// no floating point on-chain).
fn year_from_unix(ts: i64) -> u16 {
    let days = ts.div_euclid(86_400); // days since 1970-01-01
    let z = days + 719_468; // shift to the 0000-03-01 civil epoch
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
fn effective_bounty_usd(cfg: &BountyConfig, year: u16) -> Result<u64, ProgramError> {
    let years = (year as u32).saturating_sub(cfg.base_year as u32);
    let mut usd = cfg.bounty_usd_raw as u128;
    let scale = 10_000u128 + cfg.annual_inflation_bps as u128;
    for _ in 0..years {
        usd = usd.checked_mul(scale).ok_or(err(ERR_MATH_OVERFLOW))? / 10_000;
    }
    Ok(usd as u64)
}

/// SOL/USDC price in floor units — (usdc_raw × 1e6) / wsol_raw — from the two
/// pool vault token accounts.
fn read_sol_usdc_price<'a>(
    wsol_vault: &solana_program::account_info::AccountInfo<'a>,
    usdc_vault: &solana_program::account_info::AccountInfo<'a>,
) -> Result<u64, ProgramError> {
    let wsol_raw = token_account_amount(wsol_vault)?;
    let usdc_raw = token_account_amount(usdc_vault)?;
    if wsol_raw == 0 {
        return Err(err(ERR_INVALID_SOL_PRICE));
    }
    Ok((usdc_raw as u128 * 1_000_000u128 / wsol_raw as u128) as u64)
}

/// Token-account `amount` field (u64 LE at offset 64), SPL and Token-2022.
fn token_account_amount(account: &solana_program::account_info::AccountInfo) -> Result<u64, ProgramError> {
    let data = account.try_borrow_data()?;
    if data.len() < 72 {
        return Err(err(ERR_INVALID_SOL_PRICE));
    }
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

/// Bounty in lamports for this crank: pool-priced when the SOL/USDC pool is
/// configured — lamports = (usd_raw × 1e6) / sol_price_floor — falling back to
/// the fixed lamport bounty when it isn't. Both optional vault accounts are
/// pinned to the pool's derived PDAs before pricing.
fn bounty_lamports<'a>(
    cfg: &BountyConfig,
    wsol_vault: Option<&solana_program::account_info::AccountInfo<'a>>,
    usdc_vault: Option<&solana_program::account_info::AccountInfo<'a>>,
    now: i64,
) -> Result<u64, ProgramError> {
    if cfg.sol_usdc_pool != Pubkey::default() {
        let wsol_vault = wsol_vault.ok_or(err(ERR_INVALID_SOL_PRICE))?;
        let usdc_vault = usdc_vault.ok_or(err(ERR_INVALID_SOL_PRICE))?;
        // Pin the two vaults to the pool's derived PDAs.
        let (expected_wsol, _) = Pubkey::find_program_address(
            &[POOL_VAULT_SEED, cfg.sol_usdc_pool.as_ref(), WSOL_MINT.as_ref()],
            &cfg.cpmm_program,
        );
        let (expected_usdc, _) = Pubkey::find_program_address(
            &[POOL_VAULT_SEED, cfg.sol_usdc_pool.as_ref(), cfg.usdc_mint.as_ref()],
            &cfg.cpmm_program,
        );
        if wsol_vault.key != &expected_wsol || usdc_vault.key != &expected_usdc {
            return Err(err(ERR_INVALID_SOL_PRICE));
        }
        let sol_price = read_sol_usdc_price(wsol_vault, usdc_vault)?;
        if sol_price == 0 {
            return Err(err(ERR_INVALID_SOL_PRICE));
        }
        let year = year_from_unix(now);
        let usd_raw = effective_bounty_usd(cfg, year)?;
        Ok((usd_raw as u128 * 1_000_000u128 / sol_price as u128) as u64)
    } else {
        Ok(cfg.bounty_amount)
    }
}

/// Manual lamport transfer from the program-owned bounty PDA to the cranker
/// (no System-transfer CPI: the vault is program-owned, so direct lamport
/// arithmetic is the only route).
fn pay_bounty<'a>(
    vault: &solana_program::account_info::AccountInfo<'a>,
    cranker: &solana_program::account_info::AccountInfo<'a>,
    bounty: u64,
) -> Result<(), ProgramError> {
    let mut vault_lamports = vault.try_borrow_mut_lamports()?;
    let mut cranker_lamports = cranker.try_borrow_mut_lamports()?;
    **vault_lamports = vault_lamports
        .checked_sub(bounty)
        .ok_or(err(ERR_BOUNTY_EXHAUSTED))?;
    **cranker_lamports = cranker_lamports
        .checked_add(bounty)
        .ok_or(err(ERR_MATH_OVERFLOW))?;
    Ok(())
}

// ─────────────────── IDL-generation spec (anchor, idl-build only) ─────────────
// The original anchor implementation is kept as the IDL wire-contract spec:
// the anchor CLI's source parser extracts target/idl/crank_oracle.json from
// it when building with `--features idl-build`. The native code above is the
// ONLY deployed code (anchor-lang is an optional dependency and absent from
// the default build). Keep the two in sync — the `idl_discriminators_match`
// test below fails on drift.
#[cfg(feature = "idl-build")]
mod idl_spec;

// anchor's `#[program]` expansion hardcodes `crate::__client_accounts_*`
// paths, so the shim's generated client-account modules must be visible at
// the crate root under idl-build. (The deployed binary never compiles this.)
#[cfg(feature = "idl-build")]
pub(crate) use idl_spec::instruction;

#[cfg(feature = "idl-build")]
pub(crate) use idl_spec::{
    __client_accounts_fund_bounty,
    __client_accounts_initialize_bounty,
    __client_accounts_initialize_state,
    __client_accounts_permissionless_crank,
    __client_accounts_read_oracle_data,
    __client_accounts_update_bounty,
    __client_accounts_test_collect_bounty,
    __client_accounts_test_set_state,
};
#[cfg(test)]
mod tests {
    use super::*;
    use litesvm::LiteSVM;
    use switchboard_on_demand::default_queue;
    use solana_sdk::{
        account::Account,
        instruction::{AccountMeta, Instruction},
        pubkey::Pubkey,
        signature::Keypair,
        signer::Signer,
        transaction::Transaction,
        transaction::TransactionError,
    };

    const FEED_ID: [u8; 32] = [7u8; 32];
    const PRECISION: i128 = 1_000_000_000_000_000_000; // SBOD feed value scale (18)
    static TX_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn svm_with_program() -> LiteSVM {
        let mut svm = LiteSVM::new();
        let so_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/deploy/crank_oracle.so");
        let bytes = std::fs::read(&so_path)
            .unwrap_or_else(|_| panic!("missing {} — run `anchor build` first", so_path.display()));
        svm.add_program(ID, &bytes);
        svm
    }

    fn send(
        svm: &mut LiteSVM,
        ix: Instruction,
        payer: &Keypair,
        signers: &[&Keypair],
    ) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata> {
        // litesvm's blockhash is static AND validated, so identical txs would
        // collide on the deterministic signature ("AlreadyProcessed"). A
        // counter-valued payer→payer transfer (balance-neutral, fee aside)
        // makes every tx unique.
        let blockhash = svm.latest_blockhash();
        let mut all: Vec<&Keypair> = vec![payer];
        all.extend_from_slice(signers);
        let mut ixs = vec![ix];
        let n = TX_COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        ixs.push(solana_sdk::system_instruction::transfer(
            &payer.pubkey(),
            &payer.pubkey(),
            n,
        ));
        let tx = Transaction::new_signed_with_payer(&ixs, Some(&payer.pubkey()), &all, blockhash);
        svm.send_transaction(tx)
    }

    /// Build a quote account in the exact vendored SBOD on-chain layout:
    /// b"SBOracle"(8) + queue(32) + u16 LE blob len + blob, where the blob is
    /// an ED25519 instruction with one signature and a suffix carrying
    /// oracle_idxs + slot + version + b"SBOD".
    fn build_quote(queue: &Pubkey, feed_value: i128, slot: u64) -> Vec<u8> {
        // message = PackedQuoteHeader(32) + PackedFeedInfo(49)
        let mut message = vec![0u8; 32];
        message.extend_from_slice(&FEED_ID);
        message.extend_from_slice(&feed_value.to_le_bytes());
        message.push(1); // min_oracle_samples

        let msg_size = message.len() as u16;
        let blob_len = 2 + 14 + 32 + 64 + msg_size as usize + 14;

        let mut blob = vec![0u8; blob_len];
        blob[0] = 1; // num_signatures
        blob[1] = 0; // padding
        // Ed25519SignatureOffsets (7 × u16 LE) — sequential layout:
        let offsets: [u16; 7] = [
            48, // signature_offset (sig starts right after pubkey)
            0,  // signature_instruction_index
            16, // public_key_offset (pubkey starts right after offsets)
            0,  // public_key_instruction_index
            112, // message_data_offset (2 + 14 + 32 + 64)
            msg_size,
            0, // message_instruction_index
        ];
        for (i, o) in offsets.iter().enumerate() {
            blob[2 + i * 2..4 + i * 2].copy_from_slice(&o.to_le_bytes());
        }
        // pubkey [16..48], signature [48..112] stay zeroed; message at 112:
        blob[112..112 + message.len()].copy_from_slice(&message);
        // suffix: oracle_idxs(1) + slot(8) + version(1) + "SBOD"(4)
        let s = blob_len - 14;
        blob[s] = 0;
        blob[s + 1..s + 9].copy_from_slice(&slot.to_le_bytes());
        blob[s + 9] = 0; // version
        blob[s + 10..s + 14].copy_from_slice(b"SBOD");

        let mut quote = Vec::with_capacity(8 + 32 + 2 + blob_len);
        quote.extend_from_slice(b"SBOracle");
        quote.extend_from_slice(queue.as_ref());
        quote.extend_from_slice(&(blob_len as u16).to_le_bytes());
        quote.extend_from_slice(&blob);
        quote
    }

    fn quote_pda(queue: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[queue.as_ref(), FEED_ID.as_slice()], &QUOTE_PROGRAM_ID).0
    }

    fn set_quote(svm: &mut LiteSVM, queue: &Pubkey, feed_value: i128, slot: u64) -> Pubkey {
        let key = quote_pda(queue);
        let data = build_quote(queue, feed_value, slot);
        let acct = Account {
            lamports: svm.minimum_balance_for_rent_exemption(data.len()),
            data,
            owner: QUOTE_PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        };
        svm.set_account(key, acct).unwrap();
        key
    }

    struct Fixture {
        svm: LiteSVM,
        authority: Keypair,
        cranker: Keypair,
        intruder: Keypair,
        market: Pubkey,
        cfg: Pubkey,
        vault: Pubkey,
    }

    fn setup() -> Fixture {
        let mut svm = svm_with_program();
        let authority = Keypair::new();
        let cranker = Keypair::new();
        let intruder = Keypair::new();
        for k in [&authority, &cranker, &intruder] {
            svm.airdrop(&k.pubkey(), 5_000_000_000).unwrap();
        }
        let market = Pubkey::find_program_address(&[SEED_MARKET_STATUS], &ID).0;
        let cfg = Pubkey::find_program_address(&[SEED_BOUNTY_CONFIG], &ID).0;
        let vault = Pubkey::find_program_address(&[SEED_BOUNTY_VAULT], &ID).0;

        // initialize_state
        let ix = Instruction {
            program_id: ID,
            accounts: vec![
                AccountMeta::new(market, false),
                AccountMeta::new(authority.pubkey(), true),
                AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
            ],
            data: [DISC_INITIALIZE_STATE.to_vec(), vec![]].concat(),
        };
        send(&mut svm, ix, &authority, &[]).unwrap();

        // initialize_bounty (pool unset → fixed-lamport fallback)
        let mut args = Vec::new();
        args.extend_from_slice(&10_000_000u64.to_le_bytes()); // bounty_amount
        args.extend_from_slice(&750_000u64.to_le_bytes()); // bounty_usd_raw
        args.extend_from_slice(&2026u16.to_le_bytes()); // base_year
        args.extend_from_slice(&500u16.to_le_bytes()); // annual_inflation_bps
        args.extend_from_slice(&Pubkey::default().to_bytes()); // sol_usdc_pool
        args.extend_from_slice(&Pubkey::default().to_bytes()); // cpmm_program
        args.extend_from_slice(&Pubkey::default().to_bytes()); // usdc_mint
        let ix = Instruction {
            program_id: ID,
            accounts: vec![
                AccountMeta::new(authority.pubkey(), true),
                AccountMeta::new(cfg, false),
                AccountMeta::new(vault, false),
                AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
            ],
            data: [DISC_INITIALIZE_BOUNTY.to_vec(), args].concat(),
        };
        send(&mut svm, ix, &authority, &[]).unwrap();

        Fixture {
            svm,
            authority,
            cranker,
            intruder,
            market,
            cfg,
            vault,
        }
    }

    fn account_info<'a>(
        key: &'a Pubkey,
        acct: &'a mut solana_sdk::account::Account,
    ) -> solana_program::account_info::AccountInfo<'a> {
        solana_program::account_info::AccountInfo::new(
            key,
            false,
            false,
            &mut acct.lamports,
            &mut acct.data,
            &acct.owner,
            acct.executable,
            acct.rent_epoch,
        )
    }

    fn market_key() -> Pubkey {
        Pubkey::find_program_address(&[SEED_MARKET_STATUS], &ID).0
    }

    fn cfg_key() -> Pubkey {
        Pubkey::find_program_address(&[SEED_BOUNTY_CONFIG], &ID).0
    }

    fn vault_key() -> Pubkey {
        Pubkey::find_program_address(&[SEED_BOUNTY_VAULT], &ID).0
    }

    fn read_market(svm: &LiteSVM) -> MarketStatus {
        let key = market_key();
        let mut acct = svm.get_account(&key).unwrap();
        read_market_status(&account_info(&key, &mut acct)).unwrap()
    }

    fn read_cfg(svm: &LiteSVM) -> BountyConfig {
        let key = cfg_key();
        let mut acct = svm.get_account(&key).unwrap();
        read_bounty_config(&account_info(&key, &mut acct)).unwrap()
    }

    fn crank_ix(cranker: &Keypair, quote: &Pubkey, sol_vaults: Option<(Pubkey, Pubkey)>) -> Instruction {
        let mut accounts = vec![
            AccountMeta::new(cranker.pubkey(), true),
            AccountMeta::new(Pubkey::find_program_address(&[SEED_BOUNTY_CONFIG], &ID).0, false),
            AccountMeta::new(Pubkey::find_program_address(&[SEED_BOUNTY_VAULT], &ID).0, false),
            AccountMeta::new_readonly(*quote, false),
            AccountMeta::new_readonly(solana_sdk::sysvar::clock::id(), false),
            AccountMeta::new(Pubkey::find_program_address(&[SEED_MARKET_STATUS], &ID).0, false),
        ];
        if let Some((w, u)) = sol_vaults {
            accounts.push(AccountMeta::new_readonly(w, false));
            accounts.push(AccountMeta::new_readonly(u, false));
        }
        accounts.push(AccountMeta::new_readonly(
            solana_sdk::system_program::id(),
            false,
        ));
        Instruction {
            program_id: ID,
            accounts,
            data: DISC_PERMISSIONLESS_CRANK.to_vec(),
        }
    }

    #[test]
    fn idl_discriminators_match() {
        // Parse the (frozen/regenerated) IDL and assert every instruction,
        // account, and error code matches the native constants — the wire
        // contract the TS clients (keeper, scripts, tests) rely on.
        let idl_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/idl/crank_oracle.json");
        let idl: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(&idl_path)
                .unwrap_or_else(|_| panic!("missing {} — run `anchor build` first", idl_path.display())),
        )
        .unwrap();

        let ix_discs: [(&str, [u8; 8]); 10] = [
            ("initialize_bounty", DISC_INITIALIZE_BOUNTY),
            ("fund_bounty", DISC_FUND_BOUNTY),
            ("permissionless_crank", DISC_PERMISSIONLESS_CRANK),
            ("read_oracle_data", DISC_READ_ORACLE_DATA),
            ("initialize_state", DISC_INITIALIZE_STATE),
            ("set_authority", DISC_SET_AUTHORITY),
            ("set_bounty_amount", DISC_SET_BOUNTY_AMOUNT),
            ("set_bounty_usd", DISC_SET_BOUNTY_USD),
            ("test_collect_bounty", DISC_TEST_COLLECT_BOUNTY),
            ("test_set_state", DISC_TEST_SET_STATE),
        ];
        for ix in idl["instructions"].as_array().unwrap() {
            let name = ix["name"].as_str().unwrap();
            let disc: Vec<u8> = ix["discriminator"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap() as u8)
                .collect();
            let expected = ix_discs
                .iter()
                .find(|(n, _)| *n == name)
                .unwrap_or_else(|| panic!("instruction {name} not in the native dispatch"))
                .1;
            assert_eq!(disc.as_slice(), &expected, "instruction discriminator drift: {name}");
        }

        let acct_discs: [(&str, [u8; 8]); 2] = [
            ("BountyConfig", DISC_BOUNTY_CONFIG),
            ("MarketStatus", DISC_MARKET_STATUS),
        ];
        for a in idl["accounts"].as_array().unwrap() {
            let name = a["name"].as_str().unwrap();
            let disc: Vec<u8> = a["discriminator"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap() as u8)
                .collect();
            let expected = acct_discs
                .iter()
                .find(|(n, _)| *n == name)
                .unwrap_or_else(|| panic!("account {name} not in the native layouts"))
                .1;
            assert_eq!(disc.as_slice(), &expected, "account discriminator drift: {name}");
        }

        for e in idl["errors"].as_array().unwrap() {
            let code = e["code"].as_u64().unwrap() as u32;
            let name = e["name"].as_str().unwrap();
            let expected = match name {
                "NoFeeds" => ERR_NO_FEEDS,
                "InvalidFeedValue" => ERR_INVALID_FEED_VALUE,
                "InvalidMarketState" => ERR_INVALID_MARKET_STATE,
                "InvalidAuthority" => ERR_INVALID_AUTHORITY,
                "QuoteTooStale" => ERR_QUOTE_TOO_STALE,
                "StaleQuote" => ERR_STALE_QUOTE,
                "BountyExhausted" => ERR_BOUNTY_EXHAUSTED,
                "InvalidSolPrice" => ERR_INVALID_SOL_PRICE,
                "MathOverflow" => ERR_MATH_OVERFLOW,
                other => panic!("error {other} not in the native error codes"),
            };
            assert_eq!(code, expected, "error code drift: {name}");
        }
    }

    #[test]
    fn init_writes_sentinel_and_config() {
        let f = setup();
        let m = read_market(&f.svm);
        assert_eq!(m.state, 99, "fail-closed sentinel");
        assert_eq!(m.trading_day_index, 0);
        let c = read_cfg(&f.svm);
        assert_eq!(c.authority, f.authority.pubkey());
        assert_eq!(c.bounty_amount, 10_000_000);
        assert_eq!(c.bounty_usd_raw, 750_000);
        assert_eq!(c.bump, Pubkey::find_program_address(&[SEED_BOUNTY_CONFIG], &ID).1);
        // the account discriminators are the anchor IDL bytes
        let cfg_acct = f.svm.get_account(&f.cfg).unwrap();
        assert_eq!(&cfg_acct.data[..8], &DISC_BOUNTY_CONFIG);
        let m_acct = f.svm.get_account(&f.market).unwrap();
        assert_eq!(&m_acct.data[..8], &DISC_MARKET_STATUS);
    }

    #[test]
    fn fund_and_set_bounty_authority_gates() {
        let mut f = setup();
        // fund by non-authority → 6003
        let mut args = Vec::new();
        args.extend_from_slice(&1_000_000u64.to_le_bytes());
        let ix = Instruction {
            program_id: ID,
            accounts: vec![
                AccountMeta::new(f.intruder.pubkey(), true),
                AccountMeta::new_readonly(f.cfg, false),
                AccountMeta::new(f.vault, false),
                AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
            ],
            data: [DISC_FUND_BOUNTY.to_vec(), args].concat(),
        };
        let e = send(&mut f.svm, ix, &f.intruder, &[]).unwrap_err();
        assert_eq!(
            e.err,
            TransactionError::InstructionError(0, solana_sdk::instruction::InstructionError::Custom(ERR_INVALID_AUTHORITY))
        );

        // fund by authority
        let mut args = Vec::new();
        args.extend_from_slice(&2_000_000u64.to_le_bytes());
        let ix = Instruction {
            program_id: ID,
            accounts: vec![
                AccountMeta::new(f.authority.pubkey(), true),
                AccountMeta::new_readonly(f.cfg, false),
                AccountMeta::new(f.vault, false),
                AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
            ],
            data: [DISC_FUND_BOUNTY.to_vec(), args].concat(),
        };
        let vault_before = f.svm.get_account(&f.vault).unwrap().lamports;
        send(&mut f.svm, ix, &f.authority, &[]).unwrap();
        let vault_after = f.svm.get_account(&f.vault).unwrap().lamports;
        assert_eq!(vault_after - vault_before, 2_000_000);
        // (the vault's rent floor is litesvm's 6,960/byte — delta, not absolute)

        // set_bounty_usd by non-authority → 6003
        let mut args = Vec::new();
        args.extend_from_slice(&1u64.to_le_bytes());
        let ix = Instruction {
            program_id: ID,
            accounts: vec![
                AccountMeta::new(f.intruder.pubkey(), true),
                AccountMeta::new(f.cfg, false),
            ],
            data: [DISC_SET_BOUNTY_USD.to_vec(), args].concat(),
        };
        let e = send(&mut f.svm, ix, &f.intruder, &[]).unwrap_err();
        assert_eq!(
            e.err,
            TransactionError::InstructionError(0, solana_sdk::instruction::InstructionError::Custom(ERR_INVALID_AUTHORITY))
        );

        // set_bounty_amount by authority
        let mut args = Vec::new();
        args.extend_from_slice(&25_000_000u64.to_le_bytes());
        let ix = Instruction {
            program_id: ID,
            accounts: vec![
                AccountMeta::new(f.authority.pubkey(), true),
                AccountMeta::new(f.cfg, false),
            ],
            data: [DISC_SET_BOUNTY_AMOUNT.to_vec(), args].concat(),
        };
        send(&mut f.svm, ix, &f.authority, &[]).unwrap();
        assert_eq!(read_cfg(&f.svm).bounty_amount, 25_000_000);
    }

    fn fund_ix(payer: &Keypair, amount: u64) -> Instruction {
        let mut args = Vec::new();
        args.extend_from_slice(&amount.to_le_bytes());
        Instruction {
            program_id: ID,
            accounts: vec![
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new_readonly(cfg_key(), false),
                AccountMeta::new(vault_key(), false),
                AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
            ],
            data: [DISC_FUND_BOUNTY.to_vec(), args].concat(),
        }
    }

    #[test]
    fn transition_heartbeat_and_day_rollover() {
        let mut f = setup();
        send(&mut f.svm, fund_ix(&f.authority, 100_000_000), &f.authority, &[]).unwrap();

        let queue = default_queue();

        // Transition 99 → 2: real transition — pays the fixed-lamport bounty,
        // bumps the state-begin timestamp, consumes the quote slot.
        f.svm.warp_to_slot(10);
        let mut clock = f.svm.get_sysvar::<solana_sdk::clock::Clock>();
        clock.unix_timestamp = 1_000_000;
        f.svm.set_sysvar::<solana_sdk::clock::Clock>(&clock);

        // The intruder pays tx fees so the cranker's balance delta is exactly
        // the bounty (litesvm charges the fee payer 5,000 lamports).
        let quote = set_quote(&mut f.svm, &queue, 2 * PRECISION, 10);
        let cranker_before = f.svm.get_account(&f.cranker.pubkey()).unwrap().lamports;
        let vault_before = f.svm.get_account(&vault_key()).unwrap().lamports;
        send(&mut f.svm, crank_ix(&f.cranker, &quote, None), &f.intruder, &[&f.cranker]).unwrap();

        let m = read_market(&f.svm);
        assert_eq!(m.state, 2);
        assert_eq!(m.last_updated_timestamp, 1_000_000, "transition bumps the state-begin ts");
        assert_eq!(read_cfg(&f.svm).last_crank_slot, 10);
        let cranker_after = f.svm.get_account(&f.cranker.pubkey()).unwrap().lamports;
        assert_eq!(cranker_after - cranker_before, 10_000_000, "fixed-lamport bounty paid");
        let vault_after = f.svm.get_account(&vault_key()).unwrap().lamports;
        assert_eq!(vault_before - vault_after, 10_000_000);

        // Heartbeat: same state with a fresh quote — no bounty, no ts bump,
        // but the quote slot is still consumed.
        f.svm.warp_to_slot(20);
        let quote2 = set_quote(&mut f.svm, &queue, 2 * PRECISION, 20);
        let before = f.svm.get_account(&f.cranker.pubkey()).unwrap().lamports;
        send(&mut f.svm, crank_ix(&f.cranker, &quote2, None), &f.intruder, &[&f.cranker]).unwrap();
        let after = f.svm.get_account(&f.cranker.pubkey()).unwrap().lamports;
        assert_eq!(before, after, "heartbeat pays nothing");
        assert_eq!(read_cfg(&f.svm).last_crank_slot, 20, "heartbeat consumes the quote slot");
        assert_eq!(read_market(&f.svm).state, 2);
        assert_eq!(read_market(&f.svm).last_updated_timestamp, 1_000_000, "heartbeat does not bump ts");

        // 2 → 0 rolls the trading day forward and pays again.
        f.svm.warp_to_slot(30);
        let quote3 = set_quote(&mut f.svm, &queue, 0 * PRECISION, 30);
        let before = f.svm.get_account(&f.cranker.pubkey()).unwrap().lamports;
        send(&mut f.svm, crank_ix(&f.cranker, &quote3, None), &f.intruder, &[&f.cranker]).unwrap();
        let after = f.svm.get_account(&f.cranker.pubkey()).unwrap().lamports;
        assert_eq!(after - before, 10_000_000);
        let m = read_market(&f.svm);
        assert_eq!(m.state, 0);
        assert_eq!(m.trading_day_index, 1, "2→0 rolls the day forward");

        // Replaying the same quote → StaleQuote (6005).
        let e = send(&mut f.svm, crank_ix(&f.cranker, &quote3, None), &f.intruder, &[&f.cranker]).unwrap_err();
        assert_eq!(
            e.err,
            TransactionError::InstructionError(0, solana_sdk::instruction::InstructionError::Custom(ERR_STALE_QUOTE))
        );
    }

    #[test]
    fn transition_fails_when_vault_too_low() {
        let mut f = setup(); // vault unfunded (only rent floor)
        let queue = default_queue();
        f.svm.warp_to_slot(10);
        let quote = set_quote(&mut f.svm, &queue, 2 * PRECISION, 10);
        let e = send(&mut f.svm, crank_ix(&f.cranker, &quote, None), &f.cranker, &[]).unwrap_err();
        assert_eq!(
            e.err,
            TransactionError::InstructionError(0, solana_sdk::instruction::InstructionError::Custom(ERR_BOUNTY_EXHAUSTED))
        );
        // Nothing was committed: state still 99, last_crank_slot still 0.
        assert_eq!(read_market(&f.svm).state, 99);
        assert_eq!(read_cfg(&f.svm).last_crank_slot, 0);
    }

    #[test]
    fn invalid_feed_value_and_market_state_rejected() {
        let mut f = setup();
        let queue = default_queue();
        f.svm.warp_to_slot(10);
        // feed value 7 → valid u8 but outside the 0-3 mapping → 6002
        let quote = set_quote(&mut f.svm, &queue, 7 * PRECISION, 10);
        let e = send(&mut f.svm, crank_ix(&f.cranker, &quote, None), &f.cranker, &[]).unwrap_err();
        assert_eq!(
            e.err,
            TransactionError::InstructionError(0, solana_sdk::instruction::InstructionError::Custom(ERR_INVALID_MARKET_STATE))
        );
    }

    #[test]
    fn stale_quote_rejected() {
        let mut f = setup();
        send(&mut f.svm, fund_ix(&f.authority, 100_000_000), &f.authority, &[]).unwrap();
        let queue = default_queue();
        // A quote older than max_age (state 99 → max age 300 slots).
        let quote = set_quote(&mut f.svm, &queue, 2 * PRECISION, 5);
        f.svm.warp_to_slot(400);
        let e = send(&mut f.svm, crank_ix(&f.cranker, &quote, None), &f.cranker, &[]).unwrap_err();
        assert_eq!(
            e.err,
            TransactionError::InstructionError(0, solana_sdk::instruction::InstructionError::Custom(ERR_QUOTE_TOO_STALE))
        );
    }

    #[test]
    fn non_canonical_quote_rejected() {
        let mut f = setup();
        f.svm.warp_to_slot(10);
        let queue = default_queue();
        // Quote account at a non-canonical address (still SBOD-owned).
        let data = build_quote(&queue, 2 * PRECISION, 10);
        let rogue = Pubkey::new_unique();
        f.svm
            .set_account(
                rogue,
                Account {
                    lamports: f.svm.minimum_balance_for_rent_exemption(data.len()),
                    data,
                    owner: QUOTE_PROGRAM_ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        let e = send(&mut f.svm, crank_ix(&f.cranker, &rogue, None), &f.cranker, &[]).unwrap_err();
        assert_eq!(
            e.err,
            TransactionError::InstructionError(0, solana_sdk::instruction::InstructionError::InvalidAccountData)
        );
    }

    #[test]
    fn usd_priced_bounty_reads_pinned_pool_vaults() {
        // sol_usdc_pool pinned: bounty = usd_raw × wsol_raw / usdc_raw
        let mut svm = svm_with_program();
        let authority = Keypair::new();
        svm.airdrop(&authority.pubkey(), 5_000_000_000).unwrap();

        let pool = Pubkey::new_unique();
        let cpmm_program = Pubkey::new_unique();
        let usdc_mint = Pubkey::new_unique();
        let (wsol_vault_key, _) =
            Pubkey::find_program_address(&[POOL_VAULT_SEED, pool.as_ref(), WSOL_MINT.as_ref()], &cpmm_program);
        let (usdc_vault_key, _) =
            Pubkey::find_program_address(&[POOL_VAULT_SEED, pool.as_ref(), usdc_mint.as_ref()], &cpmm_program);

        let market = Pubkey::find_program_address(&[SEED_MARKET_STATUS], &ID).0;
        let cfg_key = Pubkey::find_program_address(&[SEED_BOUNTY_CONFIG], &ID).0;
        let vault_key = Pubkey::find_program_address(&[SEED_BOUNTY_VAULT], &ID).0;

        // initialize_state + initialize_bounty (pool pinned)
        let ix = Instruction {
            program_id: ID,
            accounts: vec![
                AccountMeta::new(market, false),
                AccountMeta::new(authority.pubkey(), true),
                AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
            ],
            data: [DISC_INITIALIZE_STATE.to_vec(), vec![]].concat(),
        };
        send(&mut svm, ix, &authority, &[]).unwrap();

        let mut args = Vec::new();
        args.extend_from_slice(&10_000_000u64.to_le_bytes());
        args.extend_from_slice(&750_000u64.to_le_bytes()); // $0.75
        args.extend_from_slice(&2026u16.to_le_bytes());
        args.extend_from_slice(&500u16.to_le_bytes());
        args.extend_from_slice(pool.as_ref());
        args.extend_from_slice(cpmm_program.as_ref());
        args.extend_from_slice(usdc_mint.as_ref());
        let ix = Instruction {
            program_id: ID,
            accounts: vec![
                AccountMeta::new(authority.pubkey(), true),
                AccountMeta::new(cfg_key, false),
                AccountMeta::new(vault_key, false),
                AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
            ],
            data: [DISC_INITIALIZE_BOUNTY.to_vec(), args].concat(),
        };
        send(&mut svm, ix, &authority, &[]).unwrap();

        // fake pool vault token accounts: amount at offset 64 (u64 LE)
        let rent_min = svm.minimum_balance_for_rent_exemption(165);
        let token_acct = |amount: u64| {
            let mut data = vec![0u8; 165];
            data[64..72].copy_from_slice(&amount.to_le_bytes());
            Account {
                lamports: rent_min,
                data,
                owner: cpmm_program,
                executable: false,
                rent_epoch: 0,
            }
        };
        // 2 SOL / 400 USDC → $200 per SOL
        svm.set_account(wsol_vault_key, token_acct(2_000_000_000)).unwrap();
        svm.set_account(usdc_vault_key, token_acct(400_000_000_000)).unwrap();

        // fund the bounty vault so the payout can settle
        let cranker = Keypair::new();
        svm.airdrop(&cranker.pubkey(), 5_000_000_000).unwrap();
        send(&mut svm, fund_ix(&authority, 1_000_000_000), &authority, &[]).unwrap();

        // test_collect_bounty with the vaults: expect 750_000 × 2e9 / 400e9 = 3750 lamports
        let ix = Instruction {
            program_id: ID,
            accounts: vec![
                AccountMeta::new(cranker.pubkey(), true),
                AccountMeta::new_readonly(cfg_key, false),
                AccountMeta::new(vault_key, false),
                AccountMeta::new_readonly(wsol_vault_key, false),
                AccountMeta::new_readonly(usdc_vault_key, false),
            ],
            data: DISC_TEST_COLLECT_BOUNTY.to_vec(),
        };
        let before = svm.get_account(&cranker.pubkey()).unwrap().lamports;
        // authority pays the tx fee; cranker only signs.
        send(&mut svm, ix, &authority, &[&cranker]).unwrap();
        let after = svm.get_account(&cranker.pubkey()).unwrap().lamports;
        assert_eq!(after - before, 3_750, "USD-priced bounty: usd_raw × wsol / usdc");
    }

    #[test]
    fn test_set_state_ungated() {
        let mut f = setup();
        let mut args = Vec::new();
        args.push(1u8);
        args.extend_from_slice(&42u64.to_le_bytes());
        args.extend_from_slice(&123_456i64.to_le_bytes());
        let ix = Instruction {
            program_id: ID,
            accounts: vec![AccountMeta::new(f.market, false)],
            data: [DISC_TEST_SET_STATE.to_vec(), args].concat(),
        };
        // any payer, no signer on market_status
        send(&mut f.svm, ix, &f.intruder, &[]).unwrap();
        let m = read_market(&f.svm);
        assert_eq!((m.state, m.trading_day_index, m.last_updated_timestamp), (1, 42, 123_456));
    }
}
