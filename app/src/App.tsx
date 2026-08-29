import { useWallet } from '@solana/wallet-adapter-react';
import { useEffect, useRef } from 'react';
import { useDeployment } from './hooks/useDeployment';
import { useMarketStatus } from './hooks/useMarketStatus';
import LandingPage from './pages/LandingPage';

const BURST_DURATION_MS = 350;
const SCROLL_THROTTLE_MS = 120;
const MOVE_THROTTLE_MS = 80;

function App() {
    const { connected } = useWallet();
    const { deployment, loading, error } = useDeployment();
    const { data: marketData } = useMarketStatus(deployment?.marketStatusKey);
    const shellRef = useRef<HTMLDivElement>(null);
    const burstTimer = useRef<number | null>(null);
    const lastScroll = useRef(0);
    const lastMove = useRef(0);

    useEffect(() => {
        const shell = shellRef.current;
        if (!shell) return;

        const triggerBurst = () => {
            shell.setAttribute('data-glitch-burst', 'true');
            if (burstTimer.current) {
                window.clearTimeout(burstTimer.current);
            }
            burstTimer.current = window.setTimeout(() => {
                shell.removeAttribute('data-glitch-burst');
            }, BURST_DURATION_MS);
        };

        const onScroll = () => {
            const now = Date.now();
            if (now - lastScroll.current < SCROLL_THROTTLE_MS) return;
            lastScroll.current = now;
            triggerBurst();
        };

        const onMouseMove = () => {
            const now = Date.now();
            if (now - lastMove.current < MOVE_THROTTLE_MS) return;
            lastMove.current = now;
            triggerBurst();
        };

        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('mousemove', onMouseMove, { passive: true });

        return () => {
            window.removeEventListener('scroll', onScroll);
            window.removeEventListener('mousemove', onMouseMove);
            if (burstTimer.current) {
                window.clearTimeout(burstTimer.current);
            }
        };
    }, []);

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
