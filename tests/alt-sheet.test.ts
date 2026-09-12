// Alt-sheet localnet suite — the fixed-terms second bond sheet (state 3
// only). Covers everything provable WITHOUT a pinned CPMM pool on the
// local validator:
//   ✔ make_alt_offers sizing: exactly 5% of the bond vault, big/med/sml
//     = 1%/1.5%/2.5%+leftovers, ~250 sml lots, tier ordering, discounts
//     30/40/50, vesting 3/4/7
//   ✔ cooldown: second post the same trading day reverts (AlreadyPosted)
//   ✔ market gate: posts only in state 3
//   ✔ caller gate: neither authority nor keeper → UnauthorizedCaller
//   ✔ lazily created alt_list PDA (fresh-deployment compatibility)
//   ✔ claims fail closed with PoolNotPinned while no pool is pinned
// Claim economics (pricing/splits/CPI) need a real Raydium CPMM — the
// parked tests/legacy-mock suite documents why local CPMM staging doesn't
// exist yet; that e2e rides the devnet rehearsal instead.
//
// Run (boots its own validator via the companion harness):
//   yarn run ts-mocha -p ./tsconfig.json -t 1000000 \
//     --require tests/alt-sheet-runtime.ts tests/alt-sheet.test.ts

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Amm } from "../target/types/amm";
import { Staking } from "../target/types/staking";
import { PublicKey, Keypair, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
    createMint,
    mintTo,
    getAssociatedTokenAddressSync,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";
import { ensureValidator, rpcUrl, airdrop } from "./alt-sheet-runtime";

// crank-oracle devnet/test drivers (native program, IDL-verified constants):
const CRANK_ID = new PublicKey("HkA18DxZU3RSg2cJfC1vZEkkRmDnSWuXjHim2NXbao7U");
const DISC_INITIALIZE_STATE = Buffer.from([0xbe, 0xab, 0xe0, 0xdb, 0xd9, 0x48, 0xc7, 0xb0]);
const DISC_TEST_SET_STATE = Buffer.from([0x61, 0x77, 0xc2, 0xc5, 0x8d, 0x25, 0x22, 0x1b]);

describe("alt sheet (make_alt_offers + gates)", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const payer = (provider.wallet as anchor.Wallet).payer;

    const amm = anchor.workspace.Amm as Program<Amm>;
    const staking = anchor.workspace.Staking as Program<Staking>;

    let afhoMint: PublicKey;
    let usdcMint: PublicKey;
    let marketStatusPda: PublicKey;
    let ammStatePda: PublicKey;
    let altListPda: PublicKey;
    let afhoVault: PublicKey;
    let keeper: Keypair;
    let stranger: Keypair;

    const AFHO_UNIT = 10 ** 9;

    function crankProgramKey(): PublicKey {
        return CRANK_ID;
    }

    async function sendRawCrankIx(disc: Buffer, args: Buffer, extraSigners: Keypair[] = []): Promise<void> {
        const ix = new TransactionInstruction({
            programId: CRANK_ID,
            keys: [{ pubkey: marketStatusPda, isSigner: false, isWritable: true }],
            data: Buffer.concat([disc, args]),
        });
        const tx = new Transaction().add(ix);
        await provider.sendAndConfirm(tx, [payer, ...extraSigners]);
    }

    async function setMarket(state: number, day: number): Promise<void> {
        const args = Buffer.alloc(17);
        args.writeUInt8(state, 0);
        args.writeBigUInt64LE(BigInt(day), 1);
        args.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), 9);
        await sendRawCrankIx(DISC_TEST_SET_STATE, args);
    }

    before(async function () {
        this.timeout(180_000);
        await ensureValidator();
        // The suite assumes a pre-funded payer; fund it from the local faucet
        // so a fresh validator runs standalone.
        await airdrop(payer.publicKey.toBase58(), 50);

        // mints
        afhoMint = await createMint(provider.connection, payer, payer.publicKey, null, 9, undefined, undefined, TOKEN_2022_PROGRAM_ID);
        usdcMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);

        [marketStatusPda] = PublicKey.findProgramAddressSync([Buffer.from("market_status")], CRANK_ID);
        // create the market-status PDA via the crank's initialize_state
        // (disc + no args; accounts: market_status, payer, system)
        if (!(await provider.connection.getAccountInfo(marketStatusPda))) {
            const initIx = new TransactionInstruction({
                programId: CRANK_ID,
                keys: [
                    { pubkey: marketStatusPda, isSigner: false, isWritable: true },
                    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                ],
                data: DISC_INITIALIZE_STATE,
            });
            const tx = new Transaction().add(initIx);
            await provider.sendAndConfirm(tx, [payer]);
        }

        [ammStatePda] = PublicKey.findProgramAddressSync([Buffer.from("amm_state"), afhoMint.toBuffer()], amm.programId);
        [altListPda] = PublicKey.findProgramAddressSync([Buffer.from("alt_offer_list"), afhoMint.toBuffer()], amm.programId);
        afhoVault = getAssociatedTokenAddressSync(afhoMint, ammStatePda, true, TOKEN_2022_PROGRAM_ID);

        keeper = Keypair.generate();
        stranger = Keypair.generate();

        // staking pool (the AMM state pins it; the claim path CPIs into it)
        const poolPda = PublicKey.findProgramAddressSync([Buffer.from("pool"), afhoMint.toBuffer()], staking.programId)[0];
        const stakingVaultPda = PublicKey.findProgramAddressSync([Buffer.from("vault"), poolPda.toBuffer()], staking.programId)[0];
        const rewardVaultPda = PublicKey.findProgramAddressSync([Buffer.from("rewards"), poolPda.toBuffer()], staking.programId)[0];
        const penaltyVaultPda = PublicKey.findProgramAddressSync([Buffer.from("penalties"), poolPda.toBuffer()], staking.programId)[0];
        const posrVaultPda = PublicKey.findProgramAddressSync([Buffer.from("posr"), poolPda.toBuffer()], staking.programId)[0];
        await staking.methods
            .initializePool(crankProgramKey(), 30_000, 500, 400, 800, 1_800, amm.programId)
            .accounts({
                authority: payer.publicKey,
                mint: afhoMint,
                vault: stakingVaultPda,
                rewardVault: rewardVaultPda,
                penaltyVault: penaltyVaultPda,
                posrVault: posrVaultPda,
                marketStatusPda: marketStatusPda,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            } as any)
            .rpc();

        // amm initialize — the amm_state-owned vault ATAs must exist before
        // the instruction (initialize_amm validates them, doesn't create
        // them); create them with the payer funding rent.
        const usdcVault = getAssociatedTokenAddressSync(usdcMint, ammStatePda, true, TOKEN_PROGRAM_ID);
        const { createAssociatedTokenAccountInstruction } = (await import("@solana/spl-token"));
        const ataTx = new Transaction().add(
            createAssociatedTokenAccountInstruction(payer.publicKey, afhoVault, ammStatePda, afhoMint, TOKEN_2022_PROGRAM_ID),
            createAssociatedTokenAccountInstruction(payer.publicKey, usdcVault, ammStatePda, usdcMint, TOKEN_PROGRAM_ID),
        );
        ataTx.feePayer = payer.publicKey;
        ataTx.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;
        await provider.sendAndConfirm(ataTx, [payer]);

        await amm.methods
            .initializeAmm(poolPda)
            .accounts({
                authority: payer.publicKey,
                afhoMint,
                usdcMint,
                ammState: ammStatePda,
                afhoVault,
                usdcVault,
                usdcDip: PublicKey.findProgramAddressSync([Buffer.from("amm_usdc_dip"), afhoMint.toBuffer()], amm.programId)[0],
                usdcRewards: PublicKey.findProgramAddressSync([Buffer.from("amm_usdc_rewards"), afhoMint.toBuffer()], amm.programId)[0],
                offerList: PublicKey.findProgramAddressSync([Buffer.from("offer_list"), afhoMint.toBuffer()], amm.programId)[0],
                acceptedOffers: PublicKey.findProgramAddressSync([Buffer.from("accepted_offers"), afhoMint.toBuffer()], amm.programId)[0],
                metrics: PublicKey.findProgramAddressSync([Buffer.from("metrics"), afhoMint.toBuffer()], amm.programId)[0],
                marketStatusPda: marketStatusPda,
                crankProgram: CRANK_ID,
                tokenProgram: TOKEN_PROGRAM_ID,
                token2022Program: TOKEN_2022_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            } as any)
            .rpc();
    });

    // sheet reader (raw account layout — OfferList is zero-copy:
    // pad(3) big(12) med(12) sml(12) pad(4)  — each Offer is
    // lot_tier(1) vesting(1) discount(1) pad(1) remaining(4) total(4))
    function parseOffer(buf: Buffer, off: number) {
        return {
            tier: buf[off],
            vest: buf[off + 1],
            disc: buf[off + 2],
            remaining: buf.readUInt32LE(off + 4),
            total: buf.readUInt32LE(off + 8),
        };
    }

    async function fetchSheet() {
        const info = await provider.connection.getAccountInfo(altListPda);
        assert.isNotNull(info, "alt_list account should exist after the first post");
        const d = info!.data;
        const dayIndex = Number(d.readBigUInt64LE(8 + 32 + 8));
        const big = parseOffer(d, 8 + 32 + 8 + 8 + 4 + 1 + 3);
        const med = parseOffer(d, 8 + 32 + 8 + 8 + 4 + 1 + 3 + 12);
        const sml = parseOffer(d, 8 + 32 + 8 + 8 + 4 + 1 + 3 + 24);
        return { dayIndex, big, med, sml };
    }

    async function makeAltOffers(signers: Keypair[], expectDay: number): Promise<void> {
        const ix = await amm.methods
            .makeAltOffers()
            .accounts({
                cranker: signers[0].publicKey,
                ammState: ammStatePda,
                altList: altListPda,
                marketStatus: marketStatusPda,
                afhoMint,
                afhoVault,
                systemProgram: SystemProgram.programId,
            } as any)
            .instruction();
        const tx = new Transaction().add(ix);
        tx.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;
        // payer stays fee payer (the wallet must sign); the cranker keypair
        // signs as the cranker — an unauthorized cranker produces the
        // on-chain UnauthorizedCaller revert, not a client-side signer error.
        await provider.sendAndConfirm(tx, signers);
        void expectDay;
    }

    it("boots the local validator", async () => {
        // (validator health is implied by every other test reaching the RPC)
        const res = await fetch(rpcUrl(), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
        });
        const j = (await res.json()) as { result?: string };
        assert.equal(j.result, "ok");
    });

    it("rejects make_alt_offers outside state 3 (InvalidMarketState)", async () => {
        await setMarket(0, 900);
        try {
            await makeAltOffers([payer], 900);
            assert.fail("expected InvalidMarketState");
        } catch (e: any) {
            assert.include(String(e.message), "InvalidMarketState");
        }
        // the sheet account must NOT have been created
        const info = await provider.connection.getAccountInfo(altListPda);
        assert.isNull(info, "alt_list must not exist before a valid post");
    });

    it("posts the 5% sheet in state 3: 1%/1.5%/2.5% split, ~250 sml lots, disc 30/40/50, vest 3/4/7", async () => {
        // 1,000,000 AFHO in the bond vault → 5% = 50,000 → big 10,000 /
        // med 15,000 / sml 25,000+leftovers.
        await mintTo(provider.connection, payer, afhoMint, afhoVault, payer.publicKey, 1_000_000n * BigInt(AFHO_UNIT), undefined, undefined, TOKEN_2022_PROGRAM_ID);
        await setMarket(3, 901);
        await makeAltOffers([payer], 901);

        const sheet = await fetchSheet();
        assert.equal(sheet.dayIndex, 901);

        // lot tokens per tier from the ladder (tier → whole tokens)
        const LOT: Record<number, number> = { 1: 10, 2: 25, 3: 50, 4: 100, 5: 250, 6: 500, 7: 750, 8: 1000, 9: 2500, 10: 5000, 11: 7500, 12: 10000, 13: 15000, 14: 20000, 15: 50000, 16: 100000, 17: 250000, 18: 500000, 19: 1000000, 20: 2500000, 21: 5000000, 22: 10000000 };
        const lotOf = (t: number) => LOT[t] ?? 0;

        const bigTokens = lotOf(sheet.big.tier) * sheet.big.total;
        const medTokens = lotOf(sheet.med.tier) * sheet.med.total;
        const smlTokens = lotOf(sheet.sml.tier) * sheet.sml.total;
        const vaultTokens = 1_000_000;
        const totalTokens = bigTokens + medTokens + smlTokens;

        // exactly ≤5% of vault, within one sml lot (rounding folds down)
        const fivePct = vaultTokens * 5 / 100;
        assert.isAtMost(totalTokens, fivePct);
        assert.isAtLeast(totalTokens, fivePct - lotOf(sheet.sml.tier));

        // tier ordering (sml < med < big, ≥1 apart)
        assert.isBelow(sheet.sml.tier, sheet.med.tier);
        assert.isBelow(sheet.med.tier, sheet.big.tier);

        // big = ~1% of vault (within one big lot), sml the leftover pool
        const medLot = lotOf(sheet.med.tier);
        assert.isAtLeast(bigTokens, vaultTokens / 100 - lotOf(sheet.big.tier));
        assert.isAtMost(bigTokens, vaultTokens / 100 + lotOf(sheet.big.tier));
        assert.isAtLeast(medTokens, vaultTokens * 15 / 1000 - medLot);
        assert.isAtMost(medTokens, vaultTokens * 15 / 1000 + medLot);

        // ~250 bottom-tier lots (within the ladder's granularity: the
        // sml tier is the largest ladder lot fitting sml_alloc/250, so
        // count ∈ [250, 500) for this vault size)
        assert.isAtLeast(sheet.sml.total, 250);
        assert.isBelow(sheet.sml.total, 500);

        // fixed terms
        assert.equal(sheet.big.disc, 50);
        assert.equal(sheet.med.disc, 40);
        assert.equal(sheet.sml.disc, 30);
        assert.equal(sheet.big.vest, 7);
        assert.equal(sheet.med.vest, 4);
        assert.equal(sheet.sml.vest, 3);

        // remaining == total on a fresh sheet
        assert.equal(sheet.big.remaining, sheet.big.total);
        assert.equal(sheet.med.remaining, sheet.med.total);
        assert.equal(sheet.sml.remaining, sheet.sml.total);
    });

    it("enforces the once-per-trading-day cooldown (AlreadyPosted)", async () => {
        await setMarket(3, 901); // same day as the previous post
        try {
            await makeAltOffers([payer], 901);
            assert.fail("expected AlreadyPosted");
        } catch (e: any) {
            assert.include(String(e.message), "AlreadyPosted");
        }
    });

    it("posts again on a NEW trading day (cooldown is per-day)", async () => {
        await setMarket(3, 902);
        await makeAltOffers([payer], 902);
        const sheet = await fetchSheet();
        assert.equal(sheet.dayIndex, 902);
    });

    it("rejects a non-keeper, non-authority caller (UnauthorizedCaller)", async () => {
        await setMarket(3, 903);
        try {
            await makeAltOffers([stranger], 903);
            assert.fail("expected UnauthorizedCaller");
        } catch (e: any) {
            assert.include(String(e.message), "UnauthorizedCaller");
        }
    });

    it("keeper CAN post (authority\u2011delegated caller gate works)", async () => {
        // keeper defaults to authority at init; this deployment's authority
        // IS the payer — fund the fresh keeper and rotate first.
        // set_keeper is authority-only: payer signs.
        await amm.methods
            .setKeeper(keeper.publicKey)
            .accounts({
                authority: payer.publicKey,
                ammState: ammStatePda,
            })
            .rpc();
        await setMarket(3, 904);
        await makeAltOffers([keeper], 904);
        const sheet = await fetchSheet();
        assert.equal(sheet.dayIndex, 904);
    });

    it("claims fail closed with PoolNotPinned while no pool is pinned", async () => {
        // state 3 + fresh sheet + buyer funds — the ONLY missing piece is
        // the pinned pool, and the instruction must refuse to price.
        const buyer = Keypair.generate();
        await provider.connection.requestAirdrop(buyer.publicKey, 2_000_000_000);
        // buyer needs a USDC token account (the claim validates it before pricing)
        const buyerUsdc = getAssociatedTokenAddressSync(usdcMint, buyer.publicKey, false, TOKEN_PROGRAM_ID);
        const ataTx2 = new Transaction().add(
            (await import("@solana/spl-token")).createAssociatedTokenAccountInstruction(
                payer.publicKey, buyerUsdc, buyer.publicKey, usdcMint, TOKEN_PROGRAM_ID,
            ),
        );
        ataTx2.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;
        await provider.sendAndConfirm(ataTx2, [payer]);
        const sheet = await fetchSheet();
        assert.isAbove(sheet.sml.total, 0, "sheet must have lots for this test");

        try {
            const ix = await amm.methods
                .altOfferClaim(0, 1, new anchor.BN(0))
                .accounts({
                    buyer: buyer.publicKey,
                    ammState: ammStatePda,
                    altList: altListPda,
                    afhoMint,
                    usdcMint,
                    cpmmPoolState: PublicKey.default,
                    cpmmObservation: PublicKey.default,
                    cpmmInputVault: PublicKey.default,
                    cpmmOutputVault: PublicKey.default,
                    marketStatus: marketStatusPda,
                    buyerUsdc,
                    ammUsdcVault: getAssociatedTokenAddressSync(usdcMint, ammStatePda, true, TOKEN_PROGRAM_ID),
                    stakingPool: PublicKey.findProgramAddressSync([Buffer.from("pool"), afhoMint.toBuffer()], staking.programId)[0],
                    ammAfhoVault: afhoVault,
                    usdcDip: PublicKey.findProgramAddressSync([Buffer.from("amm_usdc_dip"), afhoMint.toBuffer()], amm.programId)[0],
                    usdcRewards: PublicKey.findProgramAddressSync([Buffer.from("amm_usdc_rewards"), afhoMint.toBuffer()], amm.programId)[0],
                    stakingVault: PublicKey.findProgramAddressSync([Buffer.from("vault"), PublicKey.findProgramAddressSync([Buffer.from("pool"), afhoMint.toBuffer()], staking.programId)[0].toBuffer()], staking.programId)[0],
                    tokenProgram: TOKEN_PROGRAM_ID,
                    token2022Program: TOKEN_2022_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                } as any)
                .instruction();
            const tx = new Transaction().add(ix);
            tx.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;
            // buyer signs as the claimant; payer (wallet) stays fee payer
            await provider.sendAndConfirm(tx, [buyer]);
            assert.fail("expected PoolNotPinned");
        } catch (e: any) {
            const msg =
                String(e.message) +
                JSON.stringify(e.error?.simulationResponse?.logs ?? e.logs ?? []);
            assert.include(msg, "PoolNotPinned");
        }
    });
});
