import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import {
    PublicKey,
    SystemProgram,
    Transaction,
    sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
    TOKEN_PROGRAM_ID,
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountInstruction,
    createSyncNativeInstruction,
    getMinimumBalanceForRentExemptAccount,
} from "@solana/spl-token";
import { writeDeploymentState } from "./deployment-state";

// Pins the Raydium SOL/USDC CPMM pool used by offer_claim_sol to convert SOL
// bond payments to USDC, and by bounty_top_up to convert USDC back to SOL.
//
// Resolution order:
//   1. DEVNET_SOL_USDC_POOL / DEVNET_SOL_USDC_CONFIG env vars (MAINNET: point
//      these at the canonical Raydium SOL/USDC pool before launch).
//   2. raydiumSolUsdcPool / raydiumSolUsdcConfig already in deployment.json.
//   3. Devnet fallback: create our own SOL/USDC CPMM pool, seeded at the same
//      200 USDC/SOL rate as the mock sol_oracle re-seeded by amm-test-data
//      (200_000_000_000 floor units = price × 1e9), so the claim's min-out
//      math lines up. Seed amounts: SOL_USDC_SEED_SOL /
//      SOL_USDC_SEED_USDC env vars (defaults 0.3 SOL / 60 USDC — the devnet
//      wallet has limited USDC; for bigger test claims seed a bigger pool).
//
// Exported for `anchor run set-pools`, which runs this before refreshing the
// claim lookup table (a NEW pool address needs its keys added to it).
export async function setSolUsdcPool(): Promise<void> {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const wallet = provider.wallet as anchor.Wallet;
    const connection = provider.connection;

    const deployment = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "app", "public", "deployment.json"), "utf-8")
    );

    let poolStateKey = process.env.DEVNET_SOL_USDC_POOL || deployment.raydiumSolUsdcPool;
    let ammConfigKey = process.env.DEVNET_SOL_USDC_CONFIG || deployment.raydiumSolUsdcConfig;

    // ── Devnet fallback: find-or-create our own SOL/USDC pool ──────────────
    if (!poolStateKey || !ammConfigKey) {
        console.log(" No SOL/USDC pool configured — looking for an existing devnet SOL/USDC CPMM pool…");
        const { Raydium, TxVersion, DEVNET_PROGRAM_ID, getCreatePoolKeys } =
            await import("@raydium-io/raydium-sdk-v2");
        const raydium = await Raydium.load({ connection, owner: wallet.payer, cluster: "devnet" });

        const feeConfigs = await raydium.api.getCpmmConfigs();
        const feeConfigs2500 = feeConfigs.filter((c) => c.tradeFeeRate === 2500);
        if (feeConfigs2500.length === 0) throw new Error("No 0.25% CPMM fee config on devnet");

        // Mints in the same sorted order the CPMM program derives pool PDAs in.
        const [mintA, mintB] =
            Buffer.compare(WSOL_MINT.toBuffer(), USDC_MINT.toBuffer()) <= 0
                ? [WSOL_MINT, USDC_MINT]
                : [USDC_MINT, WSOL_MINT];

        // Reuse a pool if one already exists for a 0.25% config. A previous
        // run can create the pool but die before recording it in
        // deployment.json — re-creating then fails inside the CPMM initialize
        // with "Allocate: account already in use" on the LP-mint PDA.
        for (const config of feeConfigs2500) {
            const keys = getCreatePoolKeys({
                programId: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM,
                configId: new PublicKey(config.id),
                mintA,
                mintB,
            });
            if (await connection.getAccountInfo(keys.poolId)) {
                poolStateKey = keys.poolId.toBase58();
                ammConfigKey = config.id;
                console.log(`    Reusing existing SOL/USDC pool: ${poolStateKey} (config ${ammConfigKey})`);
                writeDeploymentState({
                    raydiumSolUsdcPool: poolStateKey,
                    raydiumSolUsdcConfig: ammConfigKey,
                });
                break;
            }
            if (await connection.getAccountInfo(keys.lpMint)) {
                throw new Error(
                    `SOL/USDC LP mint ${keys.lpMint.toBase58()} exists but pool state ` +
                        `${keys.poolId.toBase58()} does not — a previous createPool died mid-flight. ` +
                        `Set DEVNET_SOL_USDC_POOL to an existing pool or clean up the half-created accounts.`
                );
            }
        }

        if (!poolStateKey || !ammConfigKey) {
            console.log("   No existing pool — creating a devnet SOL/USDC CPMM pool…");
            const feeConfig = feeConfigs2500[0];

            // ── Wrap SOL → wSOL (pool legs must be SPL tokens) ──────────────
            const wsolAta = getAssociatedTokenAddressSync(WSOL_MINT, wallet.publicKey, false);
            if (!(await connection.getAccountInfo(wsolAta))) {
                const createIx = createAssociatedTokenAccountInstruction(
                    wallet.publicKey,
                    wsolAta,
                    wallet.publicKey,
                    WSOL_MINT,
                    TOKEN_PROGRAM_ID
                );
                const tx = new Transaction().add(createIx);
                tx.feePayer = wallet.publicKey;
                tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
                await sendAndConfirmTransaction(connection, tx, [wallet.payer], { skipPreflight: true });
                console.log(`   wSOL ATA created: ${wsolAta.toBase58()}`);
            }
            const rentExempt = await getMinimumBalanceForRentExemptAccount(connection);
            const wrapLamports = Math.round(seedSol * 1e9) + rentExempt;
            const wrapTx = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: wallet.publicKey,
                    toPubkey: wsolAta,
                    lamports: wrapLamports,
                }),
                createSyncNativeInstruction(wsolAta, TOKEN_PROGRAM_ID)
            );
            wrapTx.feePayer = wallet.publicKey;
            wrapTx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
            await sendAndConfirmTransaction(connection, wrapTx, [wallet.payer], { skipPreflight: true });
            console.log(`   Wrapped ${seedSol} SOL → wSOL`);

            const getToken = async (mintKey: PublicKey, programId: string) => {
                const parsed = await connection.getParsedAccountInfo(mintKey);
                const info = (parsed.value!.data as { parsed: { info: { decimals: number } } }).parsed.info;
                return { address: mintKey.toBase58(), decimals: info.decimals, programId };
            };
            const wsolInfo = await getToken(WSOL_MINT, TOKEN_PROGRAM_ID.toBase58());
            const usdcInfo = await getToken(USDC_MINT, TOKEN_PROGRAM_ID.toBase58());

            const { execute, extInfo } = await raydium.cpmm.createPool({
                programId: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM,
                poolFeeAccount: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC,
                mintA: wsolInfo,
                mintB: usdcInfo,
                mintAAmount: new anchor.BN(Math.round(seedSol * 1e9)),
                mintBAmount: new anchor.BN(Math.round(seedUsdc * 1_000_000)),
                startTime: new anchor.BN(0),
                feeConfig,
                associatedOnly: false,
                ownerInfo: { useSOLBalance: true },
                txVersion: TxVersion.V0,
            });
            const { txId } = await execute({ sendAndConfirm: true });
            poolStateKey = extInfo.address.poolId.toBase58();
            ammConfigKey = extInfo.address.configId.toBase58();
            console.log(`   SOL/USDC pool created: ${poolStateKey} (tx ${txId})`);
            console.log(`    Seeded ${seedSol} SOL : ${seedUsdc} USDC (~${SEED_RATE_USDC_PER_SOL} USDC/SOL — matches the mock sol_oracle)`);
            writeDeploymentState({
                raydiumSolUsdcPool: poolStateKey,
                raydiumSolUsdcConfig: ammConfigKey,
            });
        }
    }

    const poolState = new PublicKey(poolStateKey!);
    const ammConfig = new PublicKey(ammConfigKey!);

    // ── Pin into the AMM state ─────────────────────────────────────────────
    const idlPath = path.join(process.cwd(), "target", "idl", "amm.json");
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    const program = new anchor.Program(idl, provider);
    const mint = new PublicKey(deployment.mint);

    const [ammStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("amm_state"), mint.toBuffer()],
        program.programId
    );

    const tx = await program.methods
        .setSolUsdcPool(poolState, ammConfig)
        .accounts({ cranker: provider.wallet.publicKey, ammState: ammStatePda })
        .rpc();
    console.log(` SOL/USDC pool pinned: ${poolState.toBase58()} (tx ${tx})`);
}

const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
// Devnet USDC. MAINNET: swap in the real USDC mint and uncomment it.
const USDC_MINT = new PublicKey("USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT"); // devnet (Raydium devnet faucet)
// const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // MAINNET

// 200 USDC/SOL — matches the mock sol_oracle re-seeded by amm-test-data
// (200_000_000_000 = 200 × 1e9 floor units). MAINNET: this only affects the
// fallback pool creation, which should never run on mainnet (env vars are
// used instead).
const SEED_RATE_USDC_PER_SOL = 200;

const seedSol = parseFloat(process.env.SOL_USDC_SEED_SOL || "0.3");
const seedUsdc = parseFloat(process.env.SOL_USDC_SEED_USDC || "60");

async function main() {
    await setSolUsdcPool();
}

if (require.main === module) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
