import { useWallet } from '@solana/wallet-adapter-react';
import { MarketStatus } from './components/MarketStatus';
import { PoolStats } from './components/PoolStats';
import { WalletDashboard } from './components/WalletDashboard';
import { NYSEH_MINT } from './config';

function App() {
    const { connected } = useWallet();

    return (
        <div className={`app-shell ${connected ? 'has-wallet' : ''}`}>
            {connected && (
                <section className="dashboard-section">
                    <WalletDashboard mint={NYSEH_MINT} />
                </section>
            )}

            <div className="market-status-wrapper">
                <MarketStatus />
            </div>

            <section className="stats-section">
                <PoolStats mint={NYSEH_MINT} />
            </section>
        </div>
    );
}

export default App;
