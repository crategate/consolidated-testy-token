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
                <h1>After Hours</h1>
                <div className="tagline">A token tuned to the market clock</div>
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
                        <MarketStatus marketStatusPda={deployment.marketStatusKey} variant="hero" />
                    </div>
                )}
                {connected && (
                    <MarketStatus marketStatusPda={deployment.marketStatusKey} variant="hero" />
                )}
            </div>
        </section>
    );
}
