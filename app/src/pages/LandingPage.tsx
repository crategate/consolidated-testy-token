import { useWallet } from '@solana/wallet-adapter-react';
import { HeroSection } from '../components/landing/HeroSection';
import { StakingSection } from '../components/landing/StakingSection';
import { StatsSection } from '../components/landing/StatsSection';
import { ExplainerSection } from '../components/landing/ExplainerSection';
import { BuiltWithSection } from '../components/landing/BuiltWithSection';
import type { ResolvedDeployment } from '../config';

interface LandingPageProps {
    deployment: ResolvedDeployment;
}

export default function LandingPage({ deployment }: LandingPageProps) {
    const { connected } = useWallet();

    return (
        <div className="landing-page">
            <HeroSection deployment={deployment} />
            <div className="neon-divider" style={{ '--glitch-delay': '0.3s' } as React.CSSProperties} />
            <StatsSection mint={deployment.mintKey} />
            {connected && (
                <StakingSection mint={deployment.mintKey} marketStatusPda={deployment.marketStatusKey} />
            )}
            <ExplainerSection />
            <div className="neon-divider" style={{ '--glitch-delay': '1.1s' } as React.CSSProperties} />
            <BuiltWithSection />
        </div>
    );
}
