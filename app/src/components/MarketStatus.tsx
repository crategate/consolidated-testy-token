import React from 'react';
import { useMarketStatus } from '../hooks/useMarketStatus.ts';
import './MarketStatus.css';

const STATE_LABELS: Record<number, string> = {
    0: 'Market Open',
    1: 'After Hours',
    2: 'Market Closed',
    3: 'Trading Halted',
};

const STATE_SUBTITLES: Record<number, string> = {
    0: 'NYSE is open. Staking multipliers active. No penalties.',
    1: 'After-hours session. Light penalties apply to claims & unstakes.',
    2: 'Markets are closed. Medium penalties for early exits.',
    3: 'Trading halted due to volatility. Severe penalties active.',
};

export const MarketStatus: React.FC = () => {
    const { data, loading, error, stale } = useMarketStatus();

    const state = data?.state ?? 99;
    const label = STATE_LABELS[state] ?? 'Unknown';
    const subtitle = STATE_SUBTITLES[state] ?? 'Waiting for oracle…';

    return (
        <div className="market-status-bg" data-market-state={state} aria-live="polite">
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
                            <span className="status-dot" aria-hidden="true" />
                            {label}
                            {stale && <span className="stale-badge">Stale</span>}
                        </div>
                        <h1 className="status-title">{label}</h1>
                        <p className="status-detail">{subtitle}</p>
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
