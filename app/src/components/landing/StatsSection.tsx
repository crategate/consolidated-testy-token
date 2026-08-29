import { PoolStats } from '../PoolStats';
import { PublicKey } from '@solana/web3.js';

interface StatsSectionProps {
    mint: PublicKey;
}

export function StatsSection({ mint }: StatsSectionProps) {
    return (
        <section className="stats-section section-hairline">
            <div className="landing-section-inner">
                <PoolStats mint={mint} />
            </div>
        </section>
    );
}
