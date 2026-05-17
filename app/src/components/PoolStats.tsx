import React from 'react';
import { usePoolStats } from '../hooks/usePoolStats';
import { PublicKey } from '@solana/web3.js';

interface PoolStatsProps {
    mint: PublicKey;
}

export const PoolStats: React.FC<PoolStatsProps> = ({ mint }) => {
    const { stats, loading } = usePoolStats(mint);

    if (loading || !stats) {
        return <div className="pool-stats loading">Loading on-chain stats…</div>;
    }

    const pctStaked = stats.totalSupply > 0
        ? ((stats.totalStaked / stats.totalSupply) * 100).toFixed(2)
        : '0.00';

    return (
        <div className="pool-stats">
            <div className="stat">
                <span className="stat-value">
                    {stats.totalStaked.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </span>
                <span className="stat-label">Total Staked</span>
            </div>
            <div className="stat">
                <span className="stat-value">{pctStaked}%</span>
                <span className="stat-label">Staked / Supply</span>
            </div>
            <div className="stat">
                <span className="stat-value">{stats.userCount}</span>
                <span className="stat-label">Stakers</span>
            </div>
        </div>
    );
};
