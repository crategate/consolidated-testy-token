import { useMarketStatus } from '../hooks/useMarketStatus.ts';
import { PublicKey } from '@solana/web3.js';
import { GlitchText } from './GlitchText.tsx';
import './MarketStatus.css';

const STATE_LABELS: Record<number, string> = {
    0: 'Market Open',
    1: 'After Hours',
    2: 'Market Closed',
    3: 'Trading Halted',
};

const STATE_SUBTITLES: Record<number, string> = {
    0: 'NYSE is open. Reward Claim available. No penalties to exit positions.',
    1: 'After-hours session. No reward claim available, small penalty to exit positions',
    2: 'Markets are closed. Medium penalties to principle for exiting positions.',
    3: 'Trading halted due to volatility. Severe penalties active.',
};

/* Current hour in US Eastern time — state 1 is premarket before open (morning)
   and after-hours after close (afternoon/evening). */
function nyHour(d = new Date()): number {
    return Number(
        new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            hour: 'numeric',
            hourCycle: 'h23',
        }).format(d),
    );
}

function stateTitle(state: number): string {
    if (state === 1) {
        return nyHour() < 12 ? 'Premarket Trading' : 'After Hours Trading';
    }
    return STATE_LABELS[state] ?? 'Unknown';
}

interface MarketStatusProps {
    marketStatusPda?: PublicKey;
    variant?: 'full' | 'hero' | 'compact';
}

export function MarketStatus({ marketStatusPda, variant = 'full' }: MarketStatusProps) {
    const { data, loading, error, stale } = useMarketStatus(marketStatusPda);

    const state = data?.state ?? 99;
    const label = stateTitle(state);
    const subtitle = STATE_SUBTITLES[state] ?? 'Waiting for oracle…';

    return (
        <div
            className={`market-status-bg market-status-${variant}`}
            data-market-state={state}
            aria-live="polite"
        >
            <div className="market-status-grid" aria-hidden="true" />

            <header className="market-status-header">
                {loading ? (
                    <h1>Syncing with Oracle…</h1>
                ) : error ? (
                    <>
                        <h1 className="status-error">Oracle Offline</h1>
                        <p className="status-detail">{error}</p>
                        <p className="status-meta">Check devnet connection and crank oracle deployment.</p>
                    </>
                ) : (
                    <>
                        <div className={`status-pill ${stale ? 'stale' : ''}`}>
                            {label}
                            {stale && <span className="stale-badge">Stale</span>}
                        </div>
                        <h1 className="status-title">
                            {variant === 'hero' ? (
                                <GlitchText text={label} variant="light" split="letter" step={0.4} />
                            ) : (
                                label
                            )}
                        </h1>
                        <p className="status-detail">
                            {variant === 'hero' ? (
                                <GlitchText
                                    text={subtitle}
                                    variant="light"
                                    split="word"
                                    step={0.4}
                                />
                            ) : (
                                subtitle
                            )}
                        </p>
                        {data && (
                            <p className="status-meta">
                                Trading Day #{data.tradingDay} · Oracle updated{' '}
                                {new Date(data.timestamp * 1000).toLocaleTimeString()}
                            </p>
                        )}
                    </>
                )}
            </header>
        </div>
    );
};
