import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';

export function WalletDashboard() {
    const { connected, connecting } = useWallet();

    if (!connected) {
        return (
            <div className="wallet-dashboard connect-prompt">
                <span className="glitch-border" aria-hidden="true" />
                <h2>Connect Wallet</h2>
                <p>Connect your wallet to stake AFHO and enter the bond offer desk.</p>
                <div className="wallet-button-wrapper">
                    <WalletMultiButton />
                </div>
                {connecting && <p className="connecting-text">Connecting…</p>}
            </div>
        );
    }

    return (
        <div className="wallet-dashboard">
            <div className="dashboard-header neon-glitch">
                <span className="wallet-label">Connected</span>
                <div className="wallet-button-wrapper">
                    <WalletMultiButton />
                </div>
            </div>
        </div>
    );
};
