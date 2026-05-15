import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Staking } from "../target/types/staking";
import { CrankOracle } from "../target/types/crank_oracle";
import { PublicKey } from "@solana/web3.js";

describe("staking", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  
  const staking = anchor.workspace.Staking as Program<Staking>;
  const crank = anchor.workspace.CrankOracle as Program<CrankOracle>;

  it("initializes pool and stakes", async () => {
    // 1. Initialize crank oracle market status
    const [marketPda] = PublicKey.findProgramAddressSync([Buffer.from("market_status")], crank.programId);
    await crank.methods.initializeState().accounts({ marketStatus: marketPda, payer: provider.wallet.publicKey }).rpc();
    
    // 2. Set state to 2 (closed) via read_oracle_data or permissionless_crank
    // ... (need a mock quote account for this, or use a helper)
    
    // 3. Initialize staking pool with marketPda
    // 4. Stake, then claim/unstake and assert penalties
  });
});
