import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { StakeForm } from './StakeForm';
import { Positions } from './Positions';
import { usePositions } from '../hooks/usePositions';
import type { ResolvedDeployment } from '../config';

interface WalletDashboardProps {
    deployment: ResolvedDeployment;
}

export function WalletDashboard({ deployment }: WalletDashboardProps) {
    const { connected, connecting } = useWallet();
    const mint = deployment.mintKey;
    const { refresh: refreshPositions } = usePositions(mint);
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
                <div className="wallet-button-wrapper">
                    <WalletMultiButton />
                </div>
            </div>
            <div className="dashboard-grid">
                <StakeForm mint={mint} onStakeSuccess={refreshPositions} marketStatusPda={deployment.marketStatusKey} />
                <Positions mint={mint} marketStatusPda={deployment.marketStatusKey} />
            </div>
        </div>
    );
};
