import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
    TOKEN_PROGRAM_ID,
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountInstruction,
    createSyncNativeInstruction,
    getMinimumBalanceForRentExemptAccount,
} from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";

// Rebalances the pinned devnet SOL/USDC CPMM pool back to a sane SOL price.
//
// WHY THIS EXISTS: offer_claim_sol prices + settles SOL bond payments through
// the pinned wSOL/USDCoct pool (scripts/set-sol-usdc-pool.ts). On devnet that
// pool is small, and the desk's own flows move it: bounty_top_up swaps
// USDC→wSOL through it (drains wSOL → SOL price up), SOL claims swap wSOL→USDC
// (drains USDC → SOL price down + price impact on big claims). Nothing
// re-anchors the ratio, so over time the implied SOL price drifts arbitrarily
// (observed: seeded 200 USDCoct/SOL → drifted to >2,100 USDCoct/SOL), which
// makes every SOL-denominated bond price wrong by the same factor.
//
// WHAT IT DOES: sells the over-priced side into the pool via one CPMM
// swap_base_input so the post-trade reserve ratio lands on the target price.
//   implied SOL price > target → swap wSOL in  (pool pays USDCoct out)
//   implied SOL price < target → swap USDCoct in (pool pays wSOL out)
// Reserves are the fee-adjusted tradeable reserves (vault − accrued
// protocol/fund/creator fees), matching the pool's own pricing math, and the
// input is solved with the pool's exact fee curve (trade fee on the input
// leg; protocol/fund fees are shares OF that fee).
//
// USAGE:
//   anchor run rebalance-sol-pool                 # dry-run: prints the plan
//   EXECUTE=1 anchor run rebalance-sol-pool       # executes the swap
//   SOL_POOL_TARGET_USDC_PER_SOL=180 …            # override target (default 200)
// Devnet only. On mainnet the pinned pool must be the deep canonical
// wSOL/USDC pool — rebalancing it via this script would be a bug, not a fix.

const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC_MINT = new PublicKey("USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT"); // devnet

const TARGET_USDC_PER_SOL = Number(process.env.SOL_POOL_TARGET_USDC_PER_SOL || "200");
const EXECUTE = process.env.EXECUTE === "1";
// Rebalance only when the implied price is off target by more than this.
const TOLERANCE = 0.01;

const FEE_DENOM = 1_000_000n;

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const wallet = provider.wallet as anchor.Wallet;
    const connection = provider.connection;

    const deployment = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "app", "public", "deployment.json"), "utf-8")
    );
    const poolId = process.env.DEVNET_SOL_USDC_POOL || deployment.raydiumSolUsdcPool;
    if (!poolId) throw new Error("No SOL/USDC pool pinned — run anchor run set-sol-usdc-pool first.");

    const { Raydium, TxVersion } = await import("@raydium-io/raydium-sdk-v2");
    const raydium = await Raydium.load({ connection, owner: wallet.payer, cluster: "devnet" });

    const rpc = await raydium.cpmm.getRpcPoolInfo(poolId, true);
    const { configInfo } = rpc;
    if (!configInfo) throw new Error("Pool config not found");
    // Creator fee must be OFF (feeOn = 0 / enableCreatorFee = false) for the
    // fee model below — otherwise a second fee rides on the swap and the
    // solve lands off-target. (Verified live: this devnet config carries
    // creatorFeeRate = 2500 but has it disabled.)
    if ((rpc as { enableCreatorFee?: boolean }).enableCreatorFee) {
        throw new Error("Pool has creator fees enabled — unsupported by this script's fee model.");
    }
    const tradeFeeRate = BigInt(configInfo.tradeFeeRate.toString());
    const feeMultiplier = FEE_DENOM - tradeFeeRate; // net fraction of the input leg

    const mintA = rpc.mintA as PublicKey;
    const mintB = rpc.mintB as PublicKey;
    const isBaseWsol = mintA.equals(WSOL_MINT);
    if (!isBaseWsol && !mintA.equals(USDC_MINT)) throw new Error("Unexpected pool pair (mintA)");
    if (isBaseWsol ? !mintB.equals(USDC_MINT) : !mintB.equals(WSOL_MINT)) {
        throw new Error("Unexpected pool pair (mintB)");
    }

    // Fee-adjusted tradeable reserves, oriented to (wsolRaw, usdcRaw).
    const baseReserve = BigInt(rpc.baseReserve.toString());
    const quoteReserve = BigInt(rpc.quoteReserve.toString());
    const wsolRaw = isBaseWsol ? baseReserve : quoteReserve;
    const usdcRaw = isBaseWsol ? quoteReserve : baseReserve;

    // Implied SOL price in whole USDCoct per SOL: (usdc_raw×1e-6)/(wsol_raw×1e-9).
    const priceUsdcPerSol = Number(usdcRaw) / Number(wsolRaw) * 1e3;
    console.log(`SOL/USDC pool: ${poolId}`);
    console.log(`  reserves: ${Number(wsolRaw) / 1e9} wSOL : ${Number(usdcRaw) / 1e6} USDCoct`);
    console.log(`  implied price: ${priceUsdcPerSol.toFixed(2)} USDCoct/SOL (target ${TARGET_USDC_PER_SOL})`);

    const drift = priceUsdcPerSol / TARGET_USDC_PER_SOL - 1;
    if (Math.abs(drift) <= TOLERANCE) {
        console.log("  within tolerance — nothing to do.");
        return;
    }

    // Bisect the gross input that lands the post-trade price on target.
    // We work in the swap's orientation: swapping the OVERPRICED side in.
    //   wSOL in  (pool overprices SOL): baseIn=true,  in=wsolRaw, out=usdcRaw
    //   USDC in  (pool underprices SOL): baseIn=false, in=usdcRaw, out=wsolRaw
    const swapWsolIn = priceUsdcPerSol > TARGET_USDC_PER_SOL;
    const inReserve = swapWsolIn ? wsolRaw : usdcRaw;
    const outReserve = swapWsolIn ? usdcRaw : wsolRaw;
    // Target invariant: quote'×1e3 = TARGET × base'  (price = quote×1e3/base
    // in whole-USDC-per-SOL: quote raw 1e-6 over base lamports 1e-9).
    const targetRatioNum = BigInt(Math.round(TARGET_USDC_PER_SOL));
    // Price invariant: price = quoteReserve×1e3 / baseReserve (quote = USDC
    // side, whole-USDC-per-SOL = ×1e3 of the raw ratio). Post-trade:
    //   wSOL in:  base' = base+net (WSOL is base), quote' = quote−out
    //   USDC in:  base' = base−out (WSOL is base), quote' = quote+net
    // f(d) is the signed distance to the target price after trading d; the
    // swap direction makes it monotonic decreasing (wSOL in) or increasing
    // (USDC in), so bisect with a direction-neutral "need more input" test.
    const f = (inputRaw: bigint): bigint => {
        const netIn = inputRaw * feeMultiplier / FEE_DENOM;
        const grossOut = outReserve * netIn / (inReserve + netIn);
        if (swapWsolIn) {
            const baseP = baseReserve + netIn;
            const quoteP = quoteReserve - grossOut;
            return quoteP * 1000n - targetRatioNum * baseP;
        } else {
            const baseP = baseReserve - grossOut;
            const quoteP = quoteReserve + netIn;
            return quoteP * 1000n - targetRatioNum * baseP;
        }
    };
    const needMore = (inputRaw: bigint): boolean =>
        swapWsolIn ? f(inputRaw) > 0n : f(inputRaw) < 0n;

    let lo = 1n;
    let hi = inReserve * 50n;
    if (needMore(hi)) {
        throw new Error(
            `Solve failed: even 50× the ${swapWsolIn ? "wSOL" : "USDC"} reserve cannot reach the target price.`
        );
    }
    while (lo < hi) {
        const mid = (lo + hi) / 2n;
        if (needMore(mid)) lo = mid + 1n;
        else hi = mid;
    }
    const inputRaw = lo;
    const netIn = inputRaw * feeMultiplier / FEE_DENOM;
    const grossOut = outReserve * netIn / (inReserve + netIn);

    const inputHuman = swapWsolIn ? Number(inputRaw) / 1e9 : Number(inputRaw) / 1e6;
    const outHuman = swapWsolIn ? Number(grossOut) / 1e6 : Number(grossOut) / 1e9;
    const postPrice = swapWsolIn
        ? Number(quoteReserve - grossOut) / Number(baseReserve + netIn) * 1e3
        : Number(quoteReserve + netIn) / Number(baseReserve - grossOut) * 1e3;
    console.log(`  plan: swap ${inputHuman.toFixed(6)} ${swapWsolIn ? "SOL (wSOL in)" : "USDCoct in"} → ${outHuman.toFixed(6)} ${swapWsolIn ? "USDCoct out" : "SOL out"}`);
    console.log(`  post-trade implied price ≈ ${postPrice.toFixed(2)} USDCoct/SOL`);
    if (!EXECUTE) {
        console.log("  DRY RUN — re-run with EXECUTE=1 to send the swap.");
        return;
    }

    // ── Fund the input ────────────────────────────────────────────────────
    const inputMint = swapWsolIn ? WSOL_MINT : USDC_MINT;
    const inputAta = getAssociatedTokenAddressSync(inputMint, wallet.publicKey, false, TOKEN_PROGRAM_ID);

    if (swapWsolIn) {
        const solBal = await connection.getBalance(wallet.publicKey);
        const rentExempt = await getMinimumBalanceForRentExemptAccount(connection);
        const need = inputRaw + (await connection.getAccountInfo(inputAta) ? 0n : BigInt(rentExempt)) + 10_000_000n;
        if (BigInt(solBal) < need) {
            throw new Error(
                `Wallet needs ≈${Number(need) / 1e9} SOL (input + rent + fees), has ${solBal / 1e9}.`
            );
        }
        const wrapIx = [];
        if (!(await connection.getAccountInfo(inputAta))) {
            wrapIx.push(
                createAssociatedTokenAccountInstruction(
                    wallet.publicKey, inputAta, wallet.publicKey, WSOL_MINT, TOKEN_PROGRAM_ID
                )
            );
        }
        wrapIx.push(
            SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: inputAta, lamports: inputRaw }),
            createSyncNativeInstruction(inputAta, TOKEN_PROGRAM_ID),
        );
        const wrapTx = new Transaction().add(...wrapIx);
        wrapTx.feePayer = wallet.publicKey;
        wrapTx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
        await sendAndConfirmTransaction(connection, wrapTx, [wallet.payer], { skipPreflight: true });
        console.log(`  wrapped ${inputHuman.toFixed(6)} SOL → wSOL`);
    } else {
        let usdcBal = 0n;
        try {
            const info = await connection.getTokenAccountBalance(inputAta);
            usdcBal = BigInt(info.value.amount);
        } catch {
            throw new Error(`No USDCoct token account at ${inputAta.toBase58()} — fund the wallet first.`);
        }
        if (usdcBal < inputRaw) {
            throw new Error(`Wallet needs ${Number(inputRaw) / 1e6} USDCoct, has ${Number(usdcBal) / 1e6}.`);
        }
    }

    // ── Swap ──────────────────────────────────────────────────────────────
    const { CurveCalculator } = await import("@raydium-io/raydium-sdk-v2");
    // Min-out from the pool's own curve on CURRENT reserves (creator fee off).
    const swapResult = isBaseWsol
        ? CurveCalculator.swapBaseInput(
            new BN(inputRaw.toString()),
            new BN(wsolRaw.toString()),   // input reserve (base = WSOL)
            new BN(usdcRaw.toString()),   // output reserve (quote = USDC)
            new BN(tradeFeeRate.toString()),
            new BN(0),
            new BN(configInfo.protocolFeeRate.toString()),
            new BN(configInfo.fundFeeRate.toString()),
            false,
        )
        : CurveCalculator.swapBaseInput(
            new BN(inputRaw.toString()),
            new BN(usdcRaw.toString()),   // input reserve (base = USDC)
            new BN(wsolRaw.toString()),   // output reserve (quote = WSOL)
            new BN(tradeFeeRate.toString()),
            new BN(0),
            new BN(configInfo.protocolFeeRate.toString()),
            new BN(configInfo.fundFeeRate.toString()),
            false,
        );

    const { poolInfo } = await raydium.cpmm.getPoolInfoFromRpc(poolId);
    const { execute } = await raydium.cpmm.swap({
        poolInfo,
        baseIn: swapWsolIn ? isBaseWsol : !isBaseWsol,
        inputAmount: new BN(inputRaw.toString()),
        swapResult: { inputAmount: swapResult.inputAmount, outputAmount: swapResult.outputAmount },
        slippage: 0.01,
        txVersion: TxVersion.V0,
        config: { bypassAssociatedCheck: true, associatedOnly: false },
    });
    const { txId } = await execute({ sendAndConfirm: true });
    console.log(`  swap sent: https://explorer.solana.com/tx/${txId}?cluster=devnet`);

    // Post-trade sanity read.
    const after = await raydium.cpmm.getRpcPoolInfo(poolId, true);
    const afterBase = BigInt(after.baseReserve.toString());
    const afterQuote = BigInt(after.quoteReserve.toString());
    const afterPrice = isBaseWsol
        ? Number(afterQuote) / Number(afterBase) * 1e3
        : Number(afterBase) / Number(afterQuote) * 1e3;
    console.log(`  post-trade implied price: ${afterPrice.toFixed(2)} USDCoct/SOL`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
