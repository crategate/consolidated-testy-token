import { PublicKey } from '@solana/web3.js';

export type DeploymentConfig = {
    cluster?: string;
    updatedAt?: string;
    mint?: string;
    stakingProgram?: string;
    crankProgram?: string;
    coinMintProgram?: string;
    pool?: string;
    vault?: string;
    rewardVault?: string;
    penaltyVault?: string;
    posrVault?: string;
    marketStatus?: string;
    ammProgram?: string;
    ammState?: string;
    ammOfferList?: string;
    ammSolVault?: string;
    ammUsdcVault?: string;
    ammNysehVault?: string;
    marketStatusFeedId?: string;
    priceFeedId?: string;
    oracleQuoteAccount?: string;

};

export type ResolvedDeployment = DeploymentConfig & {
    mintKey: PublicKey;
    marketStatusKey?: PublicKey;
};

export function resolveDeployment(config: DeploymentConfig): ResolvedDeployment {
    const mint = config.mint ?? import.meta.env.VITE_NYSEH_MINT;

    if (!mint) {
        throw new Error('No mint configured. Run anchor run mint, then refresh the app.');
    }

    return {
        ...config,
        mint,
        mintKey: new PublicKey(mint),
        marketStatusKey: config.marketStatus ? new PublicKey(config.marketStatus) : undefined,
    };
}
