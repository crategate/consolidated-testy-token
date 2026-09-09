#!/usr/bin/env node
// Verify the native crank-oracle's account layouts decode through the anchor
// IDL client (the keeper's read path). Run against a local validator with the
// programs loaded and init-bounty/fund-bounty already executed.
const anchor = require('@coral-xyz/anchor');
const fs = require('fs');
const { PublicKey, Connection, Keypair } = anchor.web3;
(async () => {
  const conn = new Connection('http://127.0.0.1:8899', 'confirmed');
  const idl = JSON.parse(fs.readFileSync('target/idl/crank_oracle.json'));
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(Keypair.generate()), {});
  const program = new anchor.Program(idl, provider);
  const [cfg] = PublicKey.findProgramAddressSync([Buffer.from('bounty_config')], program.programId);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from('bounty_vault')], program.programId);
  const [market] = PublicKey.findProgramAddressSync([Buffer.from('market_status')], program.programId);
  const c = await program.account.bountyConfig.fetch(cfg);
  const m = await program.account.marketStatus.fetch(market);
  console.log('bountyConfig decoded:', JSON.stringify({
    authority: c.authority.toBase58(),
    bountyAmount: c.bountyAmount.toString(),
    bountyUsdRaw: c.bountyUsdRaw.toString(),
    baseYear: c.baseYear,
    inflationBps: c.annualInflationBps,
    lastCrankSlot: c.lastCrankSlot.toString(),
    bump: c.bump,
  }));
  console.log('vault lamports:', await conn.getBalance(vault));
  console.log('marketStatus decoded:', JSON.stringify({
    state: m.currentState,
    day: m.tradingDayIndex.toString(),
    ts: m.lastUpdatedTimestamp.toString(),
  }));
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
