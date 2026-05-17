import React from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { StakeForm } from './StakeForm';
import { Positions } from './Positions';
import { PublicKey } from '@solana/web3.js';

interface WalletDashboardProps {
    mint: PublicKey;
}

export const WalletDashboard: React.FC<WalletDashboardProps> = ({ mint }) => {
    const { publicKey, connected } = useWallet();

    if (!connected) {
        return (
            <div className="wallet-dashboard connect-prompt">
                <h2>Connect Wallet</h2>
                <p>Connect your wallet to stake NYSEH and view your positions.</p>
                <WalletMultiButton />
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
                <WalletMultiButton />
            </div>
            <div className="dashboard-grid">
                <StakeForm mint={mint} />
                <Positions mint={mint} />
            </div>
        </div>
    );
};
