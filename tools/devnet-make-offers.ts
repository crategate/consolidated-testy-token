// DEVNET-ONLY: fire make_offers directly with the keeper's account wiring
// (mirrors scripts/oracle/mev-keeper.ts), then print the resulting sheet.
import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const ammIdl = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "target", "idl", "amm.json"), "utf-8")
    );
    const ammProgram = new anchor.Program(ammIdl as anchor.Idl, provider);

    const deployment = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "app", "public", "deployment.json"), "utf-8")
    );
    const afhoMint = new PublicKey(deployment.mint);
    const pda = (seed: string) =>
        PublicKey.findProgramAddressSync(
            [Buffer.from(seed), afhoMint.toBuffer()],
            ammProgram.programId
        )[0];

    const sig = await ammProgram.methods
        .makeOffers()
        .accountsStrict({
            cranker: provider.wallet.publicKey,
            ammState: new PublicKey(deployment.ammState),
            offerList: new PublicKey(deployment.ammOfferList),
            marketStatus: new PublicKey(deployment.marketStatus),
            metrics: pda("metrics"),
            acceptedOffers: pda("accepted_offers"),
            afhoMint,
            afhoVault: new PublicKey(deployment.ammAfhoVault),
            priceOracle: new PublicKey(deployment.oracleQuoteAccount),
            systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

    console.log("make_offers tx:", sig);

    const sheet = await (ammProgram.account as any).offerList.fetch(
        new PublicKey(deployment.ammOfferList)
    );
    console.log("day_index:", sheet.dayIndex.toString());
    for (const [name, o] of [
        ["big", sheet.bigOffer],
        ["med", sheet.medOffer],
        ["sml", sheet.smlOffer],
    ]) {
        console.log(
            `  ${name}: lot_size=${o.lotSize} discount_bps=${o.discountBps} ` +
                `vesting=${o.vestingDays} total=${o.totalOffered} remaining=${o.remaining}`
        );
    }
}

main().catch((e) => {
    console.error("Error:", e.message ?? e);
    process.exit(1);
});
