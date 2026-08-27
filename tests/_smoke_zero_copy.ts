import * as anchor from "@coral-xyz/anchor";
import { Amm } from "../target/types/amm";
import { CrankOracle } from "../target/types/crank_oracle";
import { MockDexPool } from "../target/types/mock_dex_pool";
import { PublicKey, Keypair, Transaction } from "@solana/web3.js";
import {
    createMint,
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountIdempotentInstruction,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";

describe("zero-copy round-trip smoke", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const payer = (provider.wallet as anchor.Wallet).payer;

    const amm = anchor.workspace.Amm as anchor.Program<Amm>;
    const crank = anchor.workspace.CrankOracle as anchor.Program<CrankOracle>;
    const mock = anchor.workspace.MockDexPool as anchor.Program<MockDexPool>;

    let afhoMint: PublicKey;
    let usdcMint: PublicKey;
    let ammStatePda: PublicKey;
    let offerListPda: PublicKey;
    let acceptedOffersPda: PublicKey;
    let metricsPda: PublicKey;

    it("initialize, fetch, mutate, fetch again", async () => {
        afhoMint = await createMint(provider.connection, payer, payer.publicKey, null, 9, undefined, undefined, TOKEN_2022_PROGRAM_ID);
        usdcMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);

        [ammStatePda] = PublicKey.findProgramAddressSync([Buffer.from("amm_state"), afhoMint.toBuffer()], amm.programId);
        [offerListPda] = PublicKey.findProgramAddressSync([Buffer.from("offer_list"), afhoMint.toBuffer()], amm.programId);
        [acceptedOffersPda] = PublicKey.findProgramAddressSync([Buffer.from("accepted_offers"), afhoMint.toBuffer()], amm.programId);
        [metricsPda] = PublicKey.findProgramAddressSync([Buffer.from("metrics"), afhoMint.toBuffer()], amm.programId);
        const [mockPricePda] = PublicKey.findProgramAddressSync([Buffer.from("mock_price"), afhoMint.toBuffer()], mock.programId);
        const [solVault] = PublicKey.findProgramAddressSync([Buffer.from("amm_sol_vault"), afhoMint.toBuffer()], amm.programId);
        const [solDip] = PublicKey.findProgramAddressSync([Buffer.from("amm_sol_dip"), afhoMint.toBuffer()], amm.programId);
        const [solRewards] = PublicKey.findProgramAddressSync([Buffer.from("amm_sol_rewards"), afhoMint.toBuffer()], amm.programId);
        const [usdcDip] = PublicKey.findProgramAddressSync([Buffer.from("amm_usdc_dip"), afhoMint.toBuffer()], amm.programId);
        const [usdcRewards] = PublicKey.findProgramAddressSync([Buffer.from("amm_usdc_rewards"), afhoMint.toBuffer()], amm.programId);
        const [marketStatusPda] = PublicKey.findProgramAddressSync([Buffer.from("market_status")], crank.programId);
        const [solOraclePda] = PublicKey.findProgramAddressSync([Buffer.from("mock_price"), usdcMint.toBuffer()], mock.programId);

        async function createAtaOffCurve(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey) {
            const ata = getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
            const tx = new Transaction().add(
                createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, owner, mint, tokenProgram),
            );
            const { blockhash } = await provider.connection.getLatestBlockhash("confirmed");
            tx.recentBlockhash = blockhash;
            tx.feePayer = payer.publicKey;
            await provider.sendAndConfirm(tx);
            return ata;
        }

        const afhoVault = await createAtaOffCurve(afhoMint, ammStatePda, TOKEN_2022_PROGRAM_ID);
        const usdcVault = await createAtaOffCurve(usdcMint, ammStatePda, TOKEN_PROGRAM_ID);

        await amm.methods
            .initializeAmm(mockPricePda, PublicKey.default, solOraclePda)
            .accounts({
                authority: payer.publicKey,
                afhoMint,
                usdcMint,
                ammState: ammStatePda,
                afhoVault,
                usdcVault,
                usdcDip,
                usdcRewards,
                solRewards,
                solDip,
                solVault,
                offerList: offerListPda,
                acceptedOffers: acceptedOffersPda,
                metrics: metricsPda,
                marketStatusPda,
                crankProgram: crank.programId,
                priceOracle: marketStatusPda,
                dexProgram: mock.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
                token2022Program: TOKEN_2022_PROGRAM_ID,
            })
            .rpc();

        const st = await amm.account.ammState.fetch(ammStatePda);
        assert.equal(st.authority.toBase58(), payer.publicKey.toBase58(), "authority");
        assert.equal(st.keeper.toBase58(), payer.publicKey.toBase58(), "keeper default");
        assert.equal(st.afhoMint.toBase58(), afhoMint.toBase58(), "afho mint");
        assert.equal(st.highestBuybackBasis.toNumber(), 0, "buyback basis zero");

        const ol = await amm.account.offerList.fetch(offerListPda);
        assert.equal(ol.owner.toBase58(), payer.publicKey.toBase58(), "offer_list owner");
        assert.equal(ol.bigOffer.lotSize, 0, "big offer empty");

        const ao = await amm.account.acceptedOffers.fetch(acceptedOffersPda);
        assert.equal(ao.bigOffersAccepted[4], 0, "accepted offers zero");

        const mm = await amm.account.marketMetrics.fetch(metricsPda);
        assert.equal(mm.treasurySol.toNumber(), 0, "metrics treasury zero");
        assert.equal(mm.spotPrices.length, 32, "spot ring length");

        const newKeeper = Keypair.generate().publicKey;
        await amm.methods
            .setKeeper(newKeeper)
            .accounts({ authority: payer.publicKey, ammState: ammStatePda })
            .rpc();

        const st2 = await amm.account.ammState.fetch(ammStatePda);
        assert.equal(st2.keeper.toBase58(), newKeeper.toBase58(), "keeper rotated and persisted");
        assert.equal(st2.authority.toBase58(), payer.publicKey.toBase58(), "authority unchanged");
    });
});
