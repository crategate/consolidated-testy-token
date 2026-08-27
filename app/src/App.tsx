import { useWallet } from '@solana/wallet-adapter-react';
import { MarketStatus } from './components/MarketStatus';
import { PoolStats } from './components/PoolStats';
import { WalletDashboard } from './components/WalletDashboard';
import { useDeployment } from './hooks/useDeployment';
import { UnderConstruction } from './components/UnderConstruction.tsx';

function App() {
    const { connected } = useWallet();
    const { deployment, loading, error } = useDeployment();
    if (loading) {
        return <div className="app-shell">Loading deployment...</div>;
    }

    if (error || !deployment) {
        return <div className="app-shell">Deployment error: {error ?? 'missing deployment'}</div>;
    }

    return (
        <div className={`app-shell ${connected ? 'has-wallet' : ''}`}>
            <UnderConstruction />
            {
                !connected && (
                    <section className="dashboard-section neon-glitch">
                        <WalletDashboard deployment={deployment} />
                    </section>
                )
            }



            {
                connected && (
                    <section className="dashboard-section neon-glitch">
                        <WalletDashboard deployment={deployment} />
                    </section>
                )
            }

            <div className="market-status-wrapper neon-glitch">
                <MarketStatus marketStatusPda={deployment.marketStatusKey} />
            </div>

            <section className="stats-section neon-glitch">
                <PoolStats mint={deployment.mintKey} />
            </section>
        </div >
    );
}

export default App;