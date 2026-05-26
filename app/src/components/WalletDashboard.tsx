import React from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { StakeForm } from './StakeForm';
import { Positions } from './Positions';
import type { ResolvedDeployment } from '../config';

interface WalletDashboardProps {
    deployment: ResolvedDeployment;
}

export const WalletDashboard: React.FC<WalletDashboardProps> = ({ deployment }) => {
    const { publicKey, connected, connecting } = useWallet();
    const mint = deployment.mintKey;

    if (!connected) {
        return (
            <div className="wallet-dashboard connect-prompt">
                <h2>Connect Wallet</h2>
                <p>Connect your wallet to stake NYSEH and view your positions.</p>
                <div className="wallet-button-wrapper">
                    <WalletMultiButton />
                </div>
                {connecting && <p className="connecting-text">Connecting...</p>}
            </div>
        );
    }

    return (
        <div className="wallet-dashboard">
            <div className="dashboard-header">
                <span className="wallet-label">Connected</span>
                <code className="wallet-pk">
                    {publicKey?.toBase58().slice(0, 4)}…{publicKey?.toBase58().slice(-4)}
                </code>
                <div className="wallet-button-wrapper">
                    <WalletMultiButton />
                </div>
            </div>
            <div className="dashboard-grid">
                <StakeForm mint={mint} marketStatusPda={deployment.marketStatusKey} />
                <Positions mint={mint} />
            </div>
        </div>
    );
};
