import { useWallet } from '@solana/wallet-adapter-react';
import { useDeployment } from './hooks/useDeployment';
import { useMarketStatus } from './hooks/useMarketStatus';
import LandingPage from './pages/LandingPage';

function App() {
    const { connected } = useWallet();
    const { deployment, loading, error } = useDeployment();
    const { data: marketData } = useMarketStatus(deployment?.marketStatusKey);

    if (loading) {
        return <div className="app-shell">Loading deployment…</div>;
    }

    if (error || !deployment) {
        return <div className="app-shell">Deployment error: {error ?? 'missing deployment'}</div>;
    }

    return (
        <div
            className="app-shell"
            data-connected={connected}
            data-market-state={marketData?.state ?? 99}
        >
            <LandingPage deployment={deployment} />
        </div>
    );
}

export default App;
