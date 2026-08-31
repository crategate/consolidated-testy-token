// Reproduces the mint-launch.ts Raydium pool block with a FULL stack trace.
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

const USDC_MINT = new PublicKey("USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT");
const AFHO_MINT = new PublicKey("H1NA7ND21ujgDeKtWPD5evRXvEJFBvuNVmYgZBNq5wYE");
const decimals = 9;
const AFHO_TO_LP = 249000000;
const USDC_TO_LP = 1200;

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const wallet = provider.wallet as anchor.Wallet;
    const connection = provider.connection;

    const { Raydium, TxVersion, DEVNET_PROGRAM_ID } = await import("@raydium-io/raydium-sdk-v2");
    const raydium = await Raydium.load({ connection, owner: wallet.payer, cluster: "devnet" });
    const feeConfigs = await raydium.api.getCpmmConfigs();
    const feeConfig = feeConfigs.find((c: any) => c.tradeFeeRate === 2500);
    console.log("fee configs:", feeConfigs.length, "| 0.25% found:", !!feeConfig);

    const getToken = async (mintKey: PublicKey, programId: string) => {
        try {
            const t = await raydium.token.getTokenInfo(mintKey.toBase58());
            return { address: t.address, decimals: t.decimals, programId: t.programId };
        } catch (e: any) {
            console.log("token API miss for", mintKey.toBase58(), "-", e.message?.slice(0, 80));
            const parsed = await connection.getParsedAccountInfo(mintKey);
            const info = (parsed.value!.data as { parsed: { info: { decimals: number } } }).parsed.info;
            return { address: mintKey.toBase58(), decimals: info.decimals, programId };
        }
    };
    const afhoInfo = await getToken(AFHO_MINT, TOKEN_2022_PROGRAM_ID.toBase58());
    const usdcInfo = await getToken(USDC_MINT, TOKEN_PROGRAM_ID.toBase58());
    console.log("afhoInfo:", JSON.stringify(afhoInfo));
    console.log("usdcInfo:", JSON.stringify(usdcInfo));

    const seedAfho = new anchor.BN(AFHO_TO_LP).mul(new anchor.BN(10).pow(new anchor.BN(decimals)));
    const seedUsdc = new anchor.BN(USDC_TO_LP).mul(new anchor.BN(1_000_000));
    console.log("seedAfho:", seedAfho.toString(), "| seedUsdc:", seedUsdc.toString());

    console.log("calling raydium.cpmm.createPool ...");
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
    console.log("createPool OK — poolId:", extInfo.address.poolId.toBase58());
    console.log("(skipping execute — not sending the tx)");
    void execute;
}

main().catch((err) => {
    console.error("=== FULL ERROR ===");
    console.error(err);
    console.error("=== STACK ===");
    console.error(err.stack);
    process.exit(1);
});
