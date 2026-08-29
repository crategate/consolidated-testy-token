import { useState } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useWallet } from '@solana/wallet-adapter-react';
import { Positions } from '../Positions';
import { usePositions } from '../../hooks/stake/usePositions';
import { useClaimAll } from '../../hooks/stake/useClaimAll';
import { useUnstake } from '../../hooks/stake/useUnstake';
import { useMarketStatus } from '../../hooks/useMarketStatus';
import { PublicKey } from '@solana/web3.js';
import { GlitchText } from '../GlitchText';

interface StakingSectionProps {
    mint: PublicKey;
    marketStatusPda?: PublicKey;
}

export function StakingSection({ mint, marketStatusPda }: StakingSectionProps) {
    const [expanded, setExpanded] = useState(true);
    const { connected } = useWallet();
    const { positions, refresh: refreshPositions } = usePositions(mint);
    const { data: marketData } = useMarketStatus(marketStatusPda);
    const { claimAll, loading: claimLoading } = useClaimAll(mint, positions, marketStatusPda);
    const { unstake } = useUnstake(mint, marketStatusPda, marketData?.state);
    const claimsOpen = marketData?.state === 0;

    const hasPositions = positions.length > 0;

    const handleClaimAll = async () => {
        try {
            const tx = await claimAll();
            alert(`All claims collected successfully! Tx: ${tx}`);
            refreshPositions();
        } catch (e) {
            alert('Failed to collect claims: ' + (e as Error).message);
        }
    };

    const handleExitAll = async () => {
        for (const pos of positions) {
            try {
                await unstake(pos);
            } catch (e) {
                alert('Failed to exit a position: ' + (e as Error).message);
                break;
            }
        }
        refreshPositions();
    };

    return (
        <section className="landing-section staking-section alt">
            <div className="landing-section-inner">
                <div className="staking-toolbar">
                    <h2><GlitchText text="Active Staking Positions" variant="streetlight" step={0.05} /></h2>
                    <div className="staking-actions">
                        {connected && hasPositions && (
                            <>
                                <button
                                    className="claim-collect"
                                    onClick={handleClaimAll}
                                    disabled={!claimsOpen || claimLoading}
                                >
                                    {!claimsOpen ? 'Claim after open' : claimLoading ? 'Collecting…' : 'Claim All Rewards'}
                                </button>
                                <button
                                    className="exit-all-button"
                                    onClick={handleExitAll}
                                    disabled={positions.length === 0}
                                >
                                    Exit All Positions
                                </button>
                            </>
                        )}
                        <button
                            className="staking-toggle neon-glitch glitch-shift"
                            onClick={() => setExpanded((v) => !v)}
                            aria-expanded={expanded}
                            style={{ '--glitch-delay': '0.6s' } as React.CSSProperties}
                        >
                            {expanded ? 'Collapse' : 'Expand'}
                        </button>
                    </div>
                </div>

                {!connected && (
                    <div className="no-positions neon-glitch glass-pane">
                        <p>Connect your wallet to view active staking positions.</p>
                        <div className="wallet-button-wrapper" style={{ marginTop: '1rem' }}>
                            <WalletMultiButton />
                        </div>
                    </div>
                )}

                {connected && expanded && (
                    <div className="staking-content">
                        <div
                            className="positions-shell neon-glitch neon-shadow glitch-double glass-pane"
                            style={{ '--glitch-delay': '0.3s', '--shadow-delay': '0.8s' } as React.CSSProperties}
                        >
                            <Positions mint={mint} marketStatusPda={marketStatusPda} />
                        </div>
                    </div>
                )}

                {connected && !expanded && hasPositions && (
                    <div className="no-positions glass-pane">
                        {positions.length} position{positions.length !== 1 ? 's' : ''} hidden.
                    </div>
                )}
            </div>
        </section>
    );
}
