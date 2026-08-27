// Simulate the anchor-deploy-style UPGRADE of crank_oracle against devnet,
// capturing the exact loader logs for the "invalid program argument" failure.
const fs = require('fs');
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
} = require('/home/kev/dev/sol/testy-token/consolidated-testy-token/node_modules/@solana/web3.js');

const RPC = 'https://api.devnet.solana.com';
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const PROGRAM_ID = new PublicKey('ENJn9r8uCBLZXJ4unADAJfgNScWZuEm3rHD2LoBDpAki');
const PROGRAM_DATA = new PublicKey('28dJL1Wv8yYjanZBpmcpfMxVN1Gc14LYzr8VevjUVFtp');
const AUTHORITY = new PublicKey('DQ6AdHxGRYsUE7q7AT8DDqSsfwzh4bFZAga1sFfyFLnT'); // programdata authority

(async () => {
  const conn = new Connection(RPC, 'confirmed');
  const so = fs.readFileSync('target/deploy/crank_oracle.so');
  console.log('.so size:', so.length);

  const buffer = Keypair.generate();
  const rent = await conn.getMinimumBalanceForRentExemption(so.length);
  console.log('buffer rent:', rent);

  const tx = new Transaction();
  tx.feePayer = AUTHORITY;

  // ix0: compute budget (like the CLI)
  tx.add(new TransactionInstruction({
    programId: new PublicKey('ComputeBudget111111111111111111111111111111'),
    keys: [],
    data: Buffer.from([0, 40, 5, 0, 0, 0, 0, 0, 0]), // SetComputeUnitLimit 0x0540 = 1400k? set 1_400_000
  }));
  // ix1: create buffer account
  tx.add(SystemProgram.createAccount({
    fromPubkey: AUTHORITY,
    newAccountPubkey: buffer.publicKey,
    lamports: rent,
    space: so.length,
    programId: LOADER,
  }));
  // ix2..: write chunks
  const CHUNK = 800;
  for (let off = 0; off < so.length; off += CHUNK) {
    const bytes = so.subarray(off, off + CHUNK);
    const data = Buffer.alloc(8 + bytes.length);
    data.writeUInt32LE(1, 0); // Write
    data.writeUInt32LE(off, 4);
    bytes.copy(data, 8);
    tx.add(new TransactionInstruction({
      programId: LOADER,
      keys: [
        { pubkey: buffer.publicKey, isWritable: true, isSigner: false },
        { pubkey: buffer.publicKey, isWritable: false, isSigner: true }, // buffer authority
      ],
      data,
    }));
  }
  // final: Upgrade
  const spill = AUTHORITY;
  const upData = Buffer.alloc(4 + 32 * 3);
  upData.writeUInt32LE(3, 0); // Upgrade
  PROGRAM_DATA.toBuffer().copy(upData, 4);
  buffer.publicKey.toBuffer().copy(upData, 36);
  spill.toBuffer().copy(upData, 68);
  tx.add(new TransactionInstruction({
    programId: LOADER,
    keys: [
      { pubkey: PROGRAM_DATA, isWritable: true, isSigner: false },
      { pubkey: PROGRAM_ID, isWritable: true, isSigner: false },
      { pubkey: buffer.publicKey, isWritable: true, isSigner: false },
      { pubkey: spill, isWritable: true, isSigner: false },
      { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isWritable: false, isSigner: false },
      { pubkey: new PublicKey('SysvarC1ock11111111111111111111111111111111'), isWritable: false, isSigner: false },
      { pubkey: buffer.publicKey, isWritable: false, isSigner: true },
      { pubkey: AUTHORITY, isWritable: false, isSigner: true },
    ],
    data: upData,
  }));

  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(buffer);

  console.log('simulating... (', tx.instructions.length, 'instructions )');
  const sim = await conn.simulateTransaction(tx, [buffer.publicKey, AUTHORITY], true);
  console.log('err:', JSON.stringify(sim.value.err));
  console.log('units:', sim.value.unitsConsumed);
  console.log('--- logs ---');
  (sim.value.logs || []).forEach((l) => console.log(l));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
