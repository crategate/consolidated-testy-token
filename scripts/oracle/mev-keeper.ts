import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";  // Anchor re-exports BN
import * as sb from "@switchboard-xyz/on-demand";
import { OracleQuote } from '@switchboard-xyz/on-demand';
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import {
    getAssociatedTokenAddressSync,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import type { CrankOracle } from "../../target/types/crank_oracle";

dotenv.config();

async function main() {
    const { connection, keypair, queue, crossbar } = await sb.AnchorUtils.loadEnv();
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(keypair), {});

    const idlPath = path.join(process.cwd(), "target", "idl", "crank_oracle.json");
    if (!fs.existsSync(idlPath)) {
        throw new Error(`IDL not found at ${idlPath}. Run 'anchor build' first.`);
    }

    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    const program = new anchor.Program(idl, provider) as unknown as anchor.Program<CrankOracle>;
    const programId = program.programId;

    const [marketStatusPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("market_status")],
        programId
    );
    const [bountyConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("bounty_config")],
        programId
    );
    const [bountyVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("bounty_vault")],
        programId
    );

    // Feed IDs: deployment.json (written by feed-deploy) wins, env FEED_ID is the legacy fallback.
    const deployment = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "app", "public", "deployment.json"), "utf-8")
    );
    const statusFeedId = deployment.marketStatusFeedId ?? process.env.FEED_ID!;
    const priceFeedId = deployment.priceFeedId;
    // Order pinned with feed-deploy: [0] = market status, [1] = price change
    const feedIds = priceFeedId ? [statusFeedId, priceFeedId] : [statusFeedId];
    const [quoteAccount] = OracleQuote.getCanonicalPubkey(queue.pubkey, feedIds);
    // Single-feed quote used when the price feed can't resolve yet (devnet / pre-indexing)
    const [statusQuoteAccount] = OracleQuote.getCanonicalPubkey(queue.pubkey, [statusFeedId]);

    // AMM program client for firing make_offers at end of trading day
    const ammIdl = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "target", "idl", "amm.json"), "utf-8")
    );
    const ammProgram = new anchor.Program(ammIdl as anchor.Idl, provider);
    const afhoMint = new PublicKey(deployment.mint);
    const ammPda = (seed: string) =>
        anchor.web3.PublicKey.findProgramAddressSync(
            [Buffer.from(seed), afhoMint.toBuffer()],
            ammProgram.programId
        )[0];
    const ammStatePda = ammPda("amm_state");
    const offerListPda = ammPda("offer_list");
    const metricsPda = ammPda("metrics");
    const acceptedOffersPda = ammPda("accepted_offers");

    console.log("🔍 Keeper started");
    console.log("Program ID:", programId.toBase58());
    console.log("Market Status:", marketStatusPda.toBase58());
    console.log("Bounty Config:", bountyConfigPda.toBase58());
    console.log("Bounty Vault:", bountyVaultPda.toBase58());

    function getSleepDuration(): number {
        const now = new Date();
        const etHour = now.getUTCHours() - (now.getTimezoneOffset() === 240 ? 4 : 5);

        if ((etHour >= 9 && etHour < 10) || (etHour >= 15 && etHour < 16)) {
            return 60_000;
        }
        if (etHour >= 10 && etHour < 15) {
            return 300_000;
        }
        if (etHour >= 4 && etHour < 20) {
            return 900_000;
        }
        return 3_600_000;
    }

    while (true) {
        const sleepMs = getSleepDuration();
        try {
            const marketStatus = await program.account.marketStatus.fetch(marketStatusPda);
            const bountyConfig = await program.account.bountyConfig.fetch(bountyConfigPda);
            // Prefer the combined [status, price] quote; fall back to the status-only one
            let activeQuote = quoteAccount;
            let quoteAccountInfo = await connection.getAccountInfo(quoteAccount);
            if (!quoteAccountInfo && feedIds.length > 1) {
                activeQuote = statusQuoteAccount;
                quoteAccountInfo = await connection.getAccountInfo(statusQuoteAccount);
            }

            if (!quoteAccountInfo) {
                console.log("Quote account not found, sleeping...");
                await sleep(sleepMs);
                continue;
            }

            // Switchboard quote layout: discriminator(8) + queue(32) + slot(8) ...
            const quoteSlot = new BN(quoteAccountInfo.data.readBigUInt64LE(40).toString());

            if (quoteSlot.gt(bountyConfig.lastCrankSlot)) {
                console.log(`🚀 Stale crank! Oracle slot ${quoteSlot} > last ${bountyConfig.lastCrankSlot}`);

                const overrides = {
                    MASSIVE_API_KEY: process.env.MASSIVE_API_KEY!,
                    EARNINGSAPI_KEY: process.env.EARNINGSAPI_KEY!,
                    JUP_API_KEY: process.env.JUP_API_KEY!,
                };
                let ixs;
                let crankQuote = activeQuote;
                try {
                    ixs = await queue.fetchManagedUpdateIxs(crossbar, feedIds, {
                        variableOverrides: overrides,
                        payer: keypair.publicKey,
                    });
                    crankQuote = quoteAccount;
                } catch (e) {
                    // Price feed won't resolve until Jupiter indexes the mint (always on devnet).
                    // Fall back to status-only so the market status crank never stalls.
                    if (feedIds.length < 2) throw e;
                    console.warn("⚠️ Combined update failed, falling back to status-only:", (e as Error).message);
                    ixs = await queue.fetchManagedUpdateIxs(crossbar, [statusFeedId], {
                        variableOverrides: overrides,
                        payer: keypair.publicKey,
                    });
                    crankQuote = statusQuoteAccount;
                }

                const crankIx = await program.methods.permissionlessCrank().accountsStrict({
                    cranker: keypair.publicKey,
                    bountyConfig: bountyConfigPda,
                    bountyVault: bountyVaultPda,
                    quoteAccount: crankQuote,
                    clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
                    marketStatus: marketStatusPda,
                    systemProgram: anchor.web3.SystemProgram.programId,
                }).instruction();

                ixs.push(crankIx);

                const tx = await sb.asV0Tx({
                    connection,
                    ixs,
                    signers: [keypair],
                    computeUnitPrice: 20_000,
                });

                const sim = await connection.simulateTransaction(tx);
                if (sim.value.err) {
                    console.error("Simulation failed:", sim.value.err);
                    console.error(sim.value.logs?.join("\n") || "NO LOGS :(")
                    await sleep(sleepMs);
                    continue;
                }

                const sig = await connection.sendTransaction(tx);
                await connection.confirmTransaction(sig, "confirmed");
                console.log(`✅ Cranked! ${sig}`);

                // Trading day ends on 0→1 (open→after-hours), 0→2 (open→closed, holiday),
                // or 3→2 (halted→closed). Fire update_tradeday_stats FIRST (it owns all
                // end-of-day metric writes), then make_offers (read-only + posts sheet).
                const prevState = marketStatus.currentState;
                const newStatus = await program.account.marketStatus.fetch(marketStatusPda);
                const dayEnded =
                    (prevState === 0 && (newStatus.currentState === 1 || newStatus.currentState === 2)) ||
                    (prevState === 3 && newStatus.currentState === 2);
                if (dayEnded) {
                    console.log(`📈 Day ended (${prevState} → ${newStatus.currentState}). Firing update_tradeday_stats + make_offers...`);
                    try {
                        const ammStateForStats = await (ammProgram.account as any).ammState.fetch(ammStatePda);
                        const statsIx = await ammProgram.methods
                            .updateTradedayStats()
                            .accountsStrict({
                                cranker: keypair.publicKey,
                                ammState: ammStatePda,
                                marketMetrics: metricsPda,
                                marketStatus: marketStatusPda,
                                priceOracle: quoteAccount,
                                stakingPool: ammStateForStats.stakingPool,
                                afhoMint,
                            })
                            .instruction();
                        const statsTx = await sb.asV0Tx({
                            connection,
                            ixs: [statsIx],
                            signers: [keypair],
                            computeUnitPrice: 20_000,
                        });
                        const statsSim = await connection.simulateTransaction(statsTx);
                        if (statsSim.value.err) {
                            console.error("update_tradeday_stats simulation failed (already updated today?):", statsSim.value.err);
                        } else {
                            const statsSig = await connection.sendTransaction(statsTx);
                            await connection.confirmTransaction(statsSig, "confirmed");
                            console.log(`✅ update_tradeday_stats fired! ${statsSig}`);
                        }

                        const makeOffersIx = await ammProgram.methods
                            .makeOffers()
                            .accountsStrict({
                                cranker: keypair.publicKey,
                                ammState: ammStatePda,
                                offerList: offerListPda,
                                marketStatus: marketStatusPda,
                                metrics: metricsPda,
                                acceptedOffers: acceptedOffersPda,
                                afhoMint: afhoMint,
                                afhoVault: new PublicKey(deployment.ammAfhoVault),
                                priceOracle: quoteAccount,
                                systemProgram: anchor.web3.SystemProgram.programId,
                            })
                            .instruction();

                        const offersTx = await sb.asV0Tx({
                            connection,
                            ixs: [makeOffersIx],
                            signers: [keypair],
                            computeUnitPrice: 20_000,
                        });
                        const offersSim = await connection.simulateTransaction(offersTx);
                        if (offersSim.value.err) {
                            console.error("make_offers simulation failed (already built today?):", offersSim.value.err);
                        } else {
                            const offersSig = await connection.sendTransaction(offersTx);
                            await connection.confirmTransaction(offersSig, "confirmed");
                            console.log(`✅ make_offers fired! ${offersSig}`);
                        }
                    } catch (e) {
                        // Never let an offer-sheet failure kill the crank loop
                        console.error("❌ end-of-day AMM sequence failed:", e);
                    }
                }

                // Trading day STARTS on any →0 transition: score yesterday's sheet fills.
                const dayStarted = prevState !== 0 && newStatus.currentState === 0;
                if (dayStarted) {
                    console.log(`📉 Day started (${prevState} → 0). Firing calc_completed_offers...`);
                    try {
                        // Live price for ratchet decay: mock_price PDA of the
                        // configured dex_program (devnet stub; MAINNET: the real
                        // absolute-price account in highest_buyback_basis units).
                        const ammStateForCalc = await (ammProgram.account as any).ammState.fetch(ammStatePda);
                        const [mockPricePda] = PublicKey.findProgramAddressSync(
                            [Buffer.from("mock_price"), afhoMint.toBuffer()],
                            new PublicKey(ammStateForCalc.dexProgram)
                        );
                        const calcIx = await ammProgram.methods
                            .calcCompletedOffers()
                            .accountsStrict({
                                cranker: keypair.publicKey,
                                ammState: ammStatePda,
                                offerList: offerListPda,
                                marketStatus: marketStatusPda,
                                acceptedOffers: acceptedOffersPda,
                                priceOracle: mockPricePda,
                            })
                            .instruction();
                        const calcTx = await sb.asV0Tx({
                            connection,
                            ixs: [calcIx],
                            signers: [keypair],
                            computeUnitPrice: 20_000,
                        });
                        const calcSim = await connection.simulateTransaction(calcTx);
                        if (calcSim.value.err) {
                            console.error("calc_completed_offers simulation failed (already recorded today?):", calcSim.value.err);
                        } else {
                            const calcSig = await connection.sendTransaction(calcTx);
                            await connection.confirmTransaction(calcSig, "confirmed");
                            console.log(`✅ calc_completed_offers fired! ${calcSig}`);
                        }
                    } catch (e) {
                        console.error("❌ calc_completed_offers failed:", e);
                    }

                    // Staker distribution: swap yesterday's 10% USDC share to
                    // AFHO and deposit into the staking reward vault. Once per
                    // day (on-chain day_index guard); a sim failure (nothing
                    // collected / no stakers) is expected and skipped.
                    try {
                        const ammStateForDist = await (ammProgram.account as any).ammState.fetch(ammStatePda);
                        const dexProgramId = new PublicKey(ammStateForDist.dexProgram);
                        const usdcMint = new PublicKey(ammStateForDist.usdcMint);
                        const [poolState] = PublicKey.findProgramAddressSync(
                            [Buffer.from("mock_pool"), afhoMint.toBuffer()],
                            dexProgramId
                        );
                        const poolAfho = getAssociatedTokenAddressSync(afhoMint, poolState, true, TOKEN_2022_PROGRAM_ID);
                        const poolUsdc = getAssociatedTokenAddressSync(usdcMint, poolState, true, TOKEN_PROGRAM_ID);
                        const stakingPoolPda = new PublicKey(ammStateForDist.stakingPool);
                        const stakingIdl = JSON.parse(fs.readFileSync(path.join(process.cwd(), "target", "idl", "staking.json"), "utf-8"));
                        const stakingProgramId = new PublicKey(stakingIdl.address ?? stakingIdl.metadata?.address);
                        const [stakingRewardVault] = PublicKey.findProgramAddressSync(
                            [Buffer.from("rewards"), stakingPoolPda.toBuffer()],
                            stakingProgramId
                        );
                        const distIx = await ammProgram.methods
                            .distributeStakerRewards()
                            .accountsStrict({
                                cranker: keypair.publicKey,
                                ammState: ammStatePda,
                                marketStatus: marketStatusPda,
                                usdcRewards: ammStateForDist.usdcRewards,
                                solRewards: ammStateForDist.solRewards,
                                solOracle: ammStateForDist.solOracle,
                                spotOracle: ammStateForDist.spotOracle,
                                afhoVault: ammStateForDist.afhoVault,
                                afhoMint,
                                usdcMint,
                                poolState,
                                poolAfho,
                                poolUsdc,
                                poolSol: poolState,
                                dexProgram: dexProgramId,
                                stakingProgram: stakingProgramId,
                                stakingPool: stakingPoolPda,
                                stakingRewardVault,
                                tokenProgram: TOKEN_PROGRAM_ID,
                                token2022Program: TOKEN_2022_PROGRAM_ID,
                                systemProgram: anchor.web3.SystemProgram.programId,
                            })
                            .instruction();
                        const distTx = await sb.asV0Tx({
                            connection,
                            ixs: [distIx],
                            signers: [keypair],
                            computeUnitPrice: 20_000,
                        });
                        const distSim = await connection.simulateTransaction(distTx);
                        if (distSim.value.err) {
                            console.log("distribute_staker_rewards skipped (already done / nothing to distribute / no stakers).");
                        } else {
                            const distSig = await connection.sendTransaction(distTx);
                            await connection.confirmTransaction(distSig, "confirmed");
                            console.log(`✅ distribute_staker_rewards fired! ${distSig}`);
                        }
                    } catch (e) {
                        console.error("❌ distribute_staker_rewards failed:", (e as Error).message);
                    }
                }
            } else {
                console.log("Oracle fresh, nothing to do.");
            }

            // dex_buyback slices: attempt every loop while the market is open.
            // On-chain pacing (MIN_SLICE_SLOTS) turns extra fires into cheap
            // no-ops; sim failures (no fills, budget spent) are expected.
            try {
                const statusNow = await program.account.marketStatus.fetch(marketStatusPda);
                if (statusNow.currentState === 0) {
                    const ammState = await (ammProgram.account as any).ammState.fetch(ammStatePda);
                    const dexProgramId = new PublicKey(ammState.dexProgram);
                    const usdcMint = new PublicKey(ammState.usdcMint);
                    // mock-dex-pool: pool token accounts are ATAs of the pool PDA
                    const [poolState] = PublicKey.findProgramAddressSync(
                        [Buffer.from("mock_pool"), afhoMint.toBuffer()],
                        dexProgramId
                    );
                    const poolAfho = getAssociatedTokenAddressSync(afhoMint, poolState, true, TOKEN_2022_PROGRAM_ID);
                    const poolUsdc = getAssociatedTokenAddressSync(usdcMint, poolState, true, TOKEN_PROGRAM_ID);
                    const bbIx = await ammProgram.methods
                        .dexBuyback()
                        .accountsStrict({
                            cranker: keypair.publicKey,
                            ammState: ammStatePda,
                            marketStatus: marketStatusPda,
                            acceptedOffers: acceptedOffersPda,
                            usdcVault: ammState.usdcVault,
                            afhoVault: ammState.afhoVault,
                            solVault: ammState.solVault,
                            solOracle: ammState.solOracle,
                            spotOracle: ammState.spotOracle,
                            afhoMint,
                            usdcMint,
                            poolState,
                            poolAfho,
                            poolUsdc,
                            poolSol: poolState,
                            dexProgram: dexProgramId,
                            tokenProgram: TOKEN_PROGRAM_ID,
                            token2022Program: TOKEN_2022_PROGRAM_ID,
                            systemProgram: anchor.web3.SystemProgram.programId,
                        })
                        .instruction();
                    const bbTx = await sb.asV0Tx({
                        connection,
                        ixs: [bbIx],
                        signers: [keypair],
                        computeUnitPrice: 20_000,
                    });
                    const bbSim = await connection.simulateTransaction(bbTx);
                    if (bbSim.value.err) {
                        console.log("dex_buyback skipped (pacing / no fills / spent).");
                    } else {
                        const bbSig = await connection.sendTransaction(bbTx);
                        await connection.confirmTransaction(bbSig, "confirmed");
                        console.log(`✅ dex_buyback slice fired! ${bbSig}`);
                    }
                }
            } catch (e) {
                // Never let a buyback attempt kill the crank loop
                console.error("❌ dex_buyback attempt failed:", (e as Error).message);
            }

            // buy_the_dip: attempt EVERY loop, any market state — the dip
            // buyer is always on. Calling it is also what keeps the spot-price
            // ring sampled. On-chain pacing + trigger turn most fires into
            // cheap no-ops; sim failures (cold start, no dip, day cap) are
            // expected.
            try {
                const ammState = await (ammProgram.account as any).ammState.fetch(ammStatePda);
                const dexProgramId = new PublicKey(ammState.dexProgram);
                const usdcMint = new PublicKey(ammState.usdcMint);
                // mock-dex-pool: pool token accounts are ATAs of the pool PDA
                const [poolState] = PublicKey.findProgramAddressSync(
                    [Buffer.from("mock_pool"), afhoMint.toBuffer()],
                    dexProgramId
                );
                const poolAfho = getAssociatedTokenAddressSync(afhoMint, poolState, true, TOKEN_2022_PROGRAM_ID);
                const poolUsdc = getAssociatedTokenAddressSync(usdcMint, poolState, true, TOKEN_PROGRAM_ID);
                const dipIx = await ammProgram.methods
                    .buyTheDip()
                    .accountsStrict({
                        cranker: keypair.publicKey,
                        ammState: ammStatePda,
                        marketStatus: marketStatusPda,
                        metrics: metricsPda,
                        spotOracle: ammState.spotOracle,
                        solOracle: ammState.solOracle,
                        usdcDip: ammState.usdcDip,
                        solDip: ammState.solDip,
                        afhoVault: ammState.afhoVault,
                        afhoMint,
                        usdcMint,
                        poolState,
                        poolAfho,
                        poolUsdc,
                        poolSol: poolState,
                        dexProgram: dexProgramId,
                        tokenProgram: TOKEN_PROGRAM_ID,
                        token2022Program: TOKEN_2022_PROGRAM_ID,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .instruction();
                const dipTx = await sb.asV0Tx({
                    connection,
                    ixs: [dipIx],
                    signers: [keypair],
                    computeUnitPrice: 20_000,
                });
                const dipSim = await connection.simulateTransaction(dipTx);
                if (dipSim.value.err) {
                    console.log("buy_the_dip skipped (cold start / no dip / pacing / cap).");
                } else {
                    const dipSig = await connection.sendTransaction(dipTx);
                    await connection.confirmTransaction(dipSig, "confirmed");
                    console.log(`✅ buy_the_dip slice fired! ${dipSig}`);
                }
            } catch (e) {
                // Never let a dip attempt kill the crank loop
                console.error("❌ buy_the_dip attempt failed:", (e as Error).message);
            }
        } catch (e) {
            console.error("❌ Crank attempt failed:", e);
        }

        await sleep(sleepMs);
    }
}

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

main();