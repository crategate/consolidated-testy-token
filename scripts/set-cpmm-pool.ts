import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";

// Pins the Raydium CPMM pool + amm_config into the AMM state so the swap
// adapter routes buybacks/dip/rewards through it. Reads the pool/amm_config
// addresses written by mint-launch (createPool). Run after `amm-init`
// (or via `anchor run set-pools`, which also pins the SOL/USDC pool and
// refreshes the claim lookup table).
export async function setCpmmPool(): Promise<void> {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const idlPath = path.join(process.cwd(), "target", "idl", "amm.json");
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    const program = new anchor.Program(idl, provider);

    const deployment = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "app", "public", "deployment.json"), "utf-8")
    );
    const mint = new PublicKey(deployment.mint);
    const cpmmProgram = new PublicKey(deployment.raydiumProgram);
    const poolState = new PublicKey(deployment.raydiumPool);
    const ammConfig = new PublicKey(deployment.raydiumAmmConfig);

    const [ammStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("amm_state"), mint.toBuffer()],
        program.programId
    );

    const tx = await program.methods
        .setCpmmPool(cpmmProgram, poolState, ammConfig)
        .accounts({ cranker: provider.wallet.publicKey, ammState: ammStatePda })
        .rpc();
    console.log(` CPMM pool pinned: ${poolState.toBase58()} (program ${cpmmProgram.toBase58()}, tx ${tx})`);
}

if (require.main === module) {
    setCpmmPool().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
