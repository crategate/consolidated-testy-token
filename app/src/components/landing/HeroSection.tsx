import { useWallet } from '@solana/wallet-adapter-react';
import { MarketStatus } from '../MarketStatus';
import { WalletDashboard } from '../WalletDashboard';
import { StakeForm } from '../StakeForm';
import { usePositions } from '../../hooks/stake/usePositions';
import type { ResolvedDeployment } from '../../config';

interface HeroSectionProps {
    deployment: ResolvedDeployment;
}

export function HeroSection({ deployment }: HeroSectionProps) {
    const { connected } = useWallet();
    const { refresh: refreshPositions } = usePositions(deployment.mintKey);

    return (
        <section className="hero-section">
            <div className="hero-brand">
                <h1><span>After</span><span>_</span><span>Hours</span></h1>
                <div className="tagline">A to<span>k</span>en <span>t</span>uned to t<span>h</span>e market clo<span>c</span>k</div>
            </div>

            <div className="hero-content">
                {connected ? (
                    <div className="hero-row">
                        <WalletDashboard />
                        <StakeForm
                            mint={deployment.mintKey}
                            onStakeSuccess={refreshPositions}
                            marketStatusPda={deployment.marketStatusKey}
                        />
                    </div>
                ) : (
                    <div className="hero-row hero-row--disconnected">
                        <WalletDashboard />
                        <div className="neon-shadow shadow-wander-b" style={{ '--shadow-delay': '0.2s' } as React.CSSProperties}>
                            <MarketStatus marketStatusPda={deployment.marketStatusKey} variant="hero" />
                        </div>
                    </div>
                )}
                {connected && (
                    <div className="neon-shadow shadow-wander-b" style={{ '--shadow-delay': '0.2s' } as React.CSSProperties}>
                        <MarketStatus marketStatusPda={deployment.marketStatusKey} variant="hero" />
                    </div>
                )}
            </div>
        </section >
    );
}
