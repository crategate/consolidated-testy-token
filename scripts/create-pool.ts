import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { PublicKey, Keypair } from "@solana/web3.js";
import {
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    getMint,
    getAccount,
    getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { writeDeploymentState } from "./deployment-state";

// create-pool.ts — launch phase 3 (after fund-launch): create the Raydium CPMM
// AFHO/USDC pool from the pool-seed ATA funded by fund-launch (25% of supply).
// Extracted from the old mint-launch.ts (2026-09-09 split); LP custody is NOT
// handled here — see scripts/burn-lp.ts (MAINNET_CHECKLIST §5: burn-all vs
// cpmm.lockLiquidity).
//
// Seed amounts SET the launch price (250M AFHO : 1250 USDC = $5e-6) and a CPMM
// pool address is a PDA of (amm_config, mint pair) — a deeper pool for the
// same pair can never be re-created, so seed the depth you want at launch or
// deposit later at ratio (raydium.cpmm.addLiquidity). Env knobs:
//   AFHO_TO_LP (whole AFHO, default 250000000), USDC_TO_LP (whole USDC,
//   default 1250), USDC_MINT (mainnet: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v).
async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const wallet = provider.wallet as anchor.Wallet;
    const connection = provider.connection;

    // MAINNET: set USDC_MINT env — devnet faucet mint is the default fallback.
    const USDC_MINT = new PublicKey(
        process.env.USDC_MINT || "USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT"
    );
    const AFHO_TO_LP = process.env.AFHO_TO_LP || "250000000"; // whole AFHO
    const USDC_TO_LP = process.env.USDC_TO_LP || "1250";      // whole USDC

    // ── 1. Mint (funded by fund-launch) ──
    const mintKeypairPath = path.join(process.cwd(), "target", "deploy", "afho_token-keypair.json");
    if (!fs.existsSync(mintKeypairPath)) {
        throw new Error("afho_token-keypair.json not found. Run 'anchor run mint-create' first.");
    }
    const AFHO_MINT = Keypair.fromSecretKey(
        new Uint8Array(JSON.parse(fs.readFileSync(mintKeypairPath, "utf-8")))
    ).publicKey;
    console.log(" AFHO mint:", AFHO_MINT.toBase58());
    const decimals = (await getMint(connection, AFHO_MINT, "confirmed", TOKEN_2022_PROGRAM_ID)).decimals;

    // ── 2. Balance preflights — clear errors instead of a half-seeded pool ──
    const seedAta = getAssociatedTokenAddressSync(AFHO_MINT, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const needAfho = BigInt(AFHO_TO_LP) * 10n ** BigInt(decimals);
    const seedBal = (await getAccount(connection, seedAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    if (seedBal < needAfho) {
        throw new Error(
            `Seed ATA holds ${seedBal} raw AFHO, need ${needAfho} (${AFHO_TO_LP}). Run 'anchor run fund-launch' first.`
        );
    }
    const usdcAta = getAssociatedTokenAddressSync(USDC_MINT, wallet.publicKey, false, TOKEN_PROGRAM_ID);
    try {
        const usdcBal = (await getAccount(connection, usdcAta, "confirmed", TOKEN_PROGRAM_ID)).amount;
        if (usdcBal < BigInt(USDC_TO_LP) * 1_000_000n) {
            console.warn(`!! USDC ATA holds ${usdcBal} raw — short of ${USDC_TO_LP} USDC; pool creation will likely fail.`);
        }
    } catch {
        console.warn("!! No USDC ATA found for this wallet — fund it first (create-pool needs the quote leg).");
    }

    // ── 3. Raydium CPMM pool ──
    try {
        const { Raydium, TxVersion, DEVNET_PROGRAM_ID } = await import("@raydium-io/raydium-sdk-v2");
        const raydium = await Raydium.load({ connection, owner: wallet.payer, cluster: "devnet" });
        const feeConfigs = await raydium.api.getCpmmConfigs();
        const feeConfig = feeConfigs.find((c) => c.tradeFeeRate === 2500);
        if (!feeConfig) throw new Error("No 0.25% CPMM fee config on devnet");

        // The Raydium token API is mainnet-oriented — on devnet it may not know
        // these mints, so fall back to reading the mint accounts from the RPC.
        const getToken = async (mintKey: PublicKey, programId: string) => {
            try {
                const t = await raydium.token.getTokenInfo(mintKey.toBase58());
                return { address: t.address, decimals: t.decimals, programId: t.programId };
            } catch {
                const parsed = await connection.getParsedAccountInfo(mintKey);
                const info = (parsed.value!.data as { parsed: { info: { decimals: number } } }).parsed.info;
                return { address: mintKey.toBase58(), decimals: info.decimals, programId };
            }
        };
        const afhoInfo = await getToken(AFHO_MINT, TOKEN_2022_PROGRAM_ID.toBase58());
        const usdcInfo = await getToken(USDC_MINT, TOKEN_PROGRAM_ID.toBase58());

        // Multiply inside BN — the raw amounts (2.5e17) exceed the JS
        // safe-integer range and bn.js asserts on numbers >= 2^53
        // (bare "Assertion failed").
        const seedAfho = new anchor.BN(AFHO_TO_LP).mul(new anchor.BN(10).pow(new anchor.BN(decimals)));
        const seedUsdc = new anchor.BN(USDC_TO_LP).mul(new anchor.BN(1_000_000)); // USDC raw (6 dec)

        const { execute, extInfo } = await raydium.cpmm.createPool({
            programId: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM,
            poolFeeAccount: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC,
            mintA: afhoInfo,
            mintB: usdcInfo,
            mintAAmount: seedAfho,
            mintBAmount: seedUsdc,
            startTime: new anchor.BN(0),
            feeConfig,
            associatedOnly: false,
            ownerInfo: { useSOLBalance: true },
            txVersion: TxVersion.V0,
        });
        const { txId } = await execute({ sendAndConfirm: true });
        const poolId = extInfo.address.poolId;
        const configId = extInfo.address.configId;
        console.log(` Raydium CPMM pool created: ${poolId.toBase58()} (tx ${txId})`);
        writeDeploymentState({
            raydiumPool: poolId.toBase58(),
            raydiumAmmConfig: configId.toBase58(),
            raydiumProgram: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM.toBase58(),
            raydiumLpMint: extInfo.address.lpMint.toBase58(),
        });
        console.log(" LP mint recorded:", extInfo.address.lpMint.toBase58());
        console.log(" Next: anchor run set-pools — then burn-lp (EXECUTE=1) at REAL launch only.");
    } catch (e) {
        console.error(
            "!! Pool creation failed (install @raydium-io/raydium-sdk-v2 and fund the USDC leg):",
            e instanceof Error ? e.message : e
        );
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
