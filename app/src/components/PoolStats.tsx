import { usePoolStats } from '../hooks/usePoolStats';
import { PublicKey } from '@solana/web3.js';

/* Stat tiles: one or two directions each, with two of them wandering
   between corners on their own slow clocks */
const SHADOW_VARIANTS = ['shadow-corner-tl', 'shadow-wander-a', 'shadow-under', 'shadow-wander-b', 'shadow-corner-br'];

interface PoolStatsProps {
    mint: PublicKey;
}

export function PoolStats({ mint }: PoolStatsProps) {
    const { stats, loading } = usePoolStats(mint);

    if (loading || !stats) {
        return <div className="pool-stats loading">Loading on-chain stats…</div>;
    }

    const pctStaked = stats.totalSupply > 0
        ? ((stats.totalStaked / stats.totalSupply) * 100).toFixed(2)
        : '0.00';

    const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

    const STAT_ITEMS = [
        { label: 'Total Staked', value: fmt(stats.totalStaked) },
        { label: 'Staked / Supply', value: `${pctStaked}%` },
        { label: 'Stakers', value: stats.userCount.toString() },
        { label: 'AFHO in Vault', value: fmt(stats.vaultBalance) },
        { label: 'Total Supply', value: `1B` },
    ];

    return (
        <div className="pool-stats">
            {STAT_ITEMS.map((item, index) => (
                <div
                    key={item.label}
                    className={`stat neon-shadow glass-pane ${SHADOW_VARIANTS[index % SHADOW_VARIANTS.length]} neon-glitch`}
                    style={{
                        '--glitch-delay': `${(index * 0.8).toFixed(2)}s`,
                        '--shadow-delay': `${(index * 0.7 + 0.3).toFixed(2)}s`,
                    } as React.CSSProperties}
                >
                    <span className="stat-value">{item.value}</span>
                    <span
                        className="stat-label text-glitch-light"
                        style={{ '--glitch-delay': `${(index * 0.9 + 0.2).toFixed(2)}s` } as React.CSSProperties}
                    >
                        {item.label}
                    </span>
                </div>
            ))}
        </div>
    );
};
