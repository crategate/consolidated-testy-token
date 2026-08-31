import { useWallet } from '@solana/wallet-adapter-react';
import { useRef } from 'react';
import { useDeployment } from './hooks/useDeployment';
import { useMarketStatus } from './hooks/useMarketStatus';
import { useGlitchBurst } from './hooks/useGlitchBurst';
import LandingPage from './pages/LandingPage';

function App() {
    const { connected } = useWallet();
    const { deployment, loading, error } = useDeployment();
    const { data: marketData } = useMarketStatus(deployment?.marketStatusKey);
    const shellRef = useRef<HTMLDivElement>(null);
    useGlitchBurst(shellRef);

    if (loading) {
        return <div className="app-shell">Loading deployment…</div>;
    }

    if (error || !deployment) {
        return <div className="app-shell">Deployment error: {error ?? 'missing deployment'}</div>;
    }

    return (
        <div
            ref={shellRef}
            className="app-shell"
            data-connected={connected}
            data-market-state={marketData?.state ?? 99}
        >
            <LandingPage deployment={deployment} />
        </div>
    );
}

export default App;
