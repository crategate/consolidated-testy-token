import { usePositions } from '../hooks/stake/usePositions';
import { usePositionRewards } from '../hooks/stake/usePositionRewards';
import { useClaimAll } from '../hooks/stake/useClaimAll';
import { useMarketStatus } from '../hooks/useMarketStatus';
import { useUnstake } from '../hooks/stake/useUnstake';
import { usePool } from '../hooks/stake/usePool';
import { PublicKey } from '@solana/web3.js';

interface PositionsProps {
    mint: PublicKey;
    marketStatusPda?: PublicKey;
}

export function Positions({ mint, marketStatusPda }: PositionsProps) {
    const { positions, loading: positionsLoading, refresh: refreshPositions } = usePositions(mint);
    const { data: marketData } = useMarketStatus(marketStatusPda);
    const { pool } = usePool(mint);
    const { enriched, claimableTotal, vestingTotal, vestingCount } = usePositionRewards(mint, positions, marketStatusPda);
    const { claimAll, loading: claimLoading } = useClaimAll(mint, positions, marketStatusPda);
    const { unstake, loadingIndex: unstakeLoadingIndex } = useUnstake(mint, marketStatusPda, marketData?.state);
    const claimsOpen = marketData?.state === 0;

    // Exit penalties apply to principal and are tiered by market state
    // (0 = open, 1 = after-hours, 2 = closed, 3 = halted).
    const exitPenaltyBps = (() => {
        switch (marketData?.state) {
            case 1:
                return pool?.afterHoursPenaltyBps ?? 0;
            case 2:
                return pool?.closedPenaltyBps ?? 0;
            case 3:
                return pool?.haltedPenaltyBps ?? 0;
            default:
                return 0;
        }
    })();
    const exitPenaltyPct = (exitPenaltyBps / 100).toFixed(exitPenaltyBps % 100 === 0 ? 0 : 2);

    const handleClaimAll = async () => {
        try {
            const tx = await claimAll();
            alert(`All claims collected successfully! Tx: ${tx}`);
            refreshPositions();
        } catch (e) {
            alert('Failed to collect claims: ' + (e as Error).message);
        }
    };

    const handleUnstake = async (position: typeof positions[number]) => {
        try {
            const tx = await unstake(position);
            alert(`Position exited successfully! Tx: ${tx}`);
            refreshPositions();
        } catch (e) {
            alert('Failed to exit position: ' + (e as Error).message);
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

    if (positionsLoading && !positions.length) return <div>Loading positions…</div>;
    if (positions.length === 0) return <div className="no-positions">No active stakes.</div>;

    const currentTradingDay = marketData?.tradingDay ?? null;

    const displayPositions = enriched.length > 0 ? enriched : positions.map(p => ({
        ...p,
        multiplierDisplay: '—',
        tradingDays: 0,
        netRewardDisplay: '—',
        penaltyRaw: 0,
        posrTaxRaw: 0,
    }));

    const getDaysRemaining = (pos: typeof positions[number]) => {
        if (pos.daysToUnlock === 0 || currentTradingDay === null) return 0;
        const unlockDay = pos.entryTradingDay + pos.daysToUnlock;
        return Math.max(0, unlockDay - currentTradingDay);
    };

    // The green tile shows CLAIMABLE AFHO only: rewards on still-vesting
    // bond positions are gated by the program (claim() rejects unvested
    // positions) and are surfaced in the vesting note below instead.
    const grandTotalDisplay = claimableTotal.toFixed(4);

    // Sum of all staked principal — the user's total balance locked in staking.
    const lockedTotal = positions.reduce((sum, pos) => sum + pos.amount, 0) / 1e9;
    const lockedTotalDisplay = lockedTotal.toFixed(2);

    return (
        <div className="positions-list">
            <div className="locked-total-header">
                <span className="locked-total-label text-glitch-light">Total locked:</span>
                <strong
                    className="locked-total-balance text-glitch"
                    style={{ '--glitch-delay': '0.9s' } as React.CSSProperties}
                >
                    {lockedTotalDisplay} AFHO
                </strong>
            </div>


            <div className="claims-header glass-pane neon-glitch ">
                <button
                    className="claim-collect"
                    onClick={handleClaimAll}
                    disabled={!claimsOpen || claimLoading || claimableTotal <= 0}
                >
                    {!claimsOpen ? 'Claim Available After Opening Bell' : claimLoading ? 'Collecting…' : 'Collect All Claims'}
                </button>
                <button
                    className="exit-all-button"
                    onClick={handleExitAll}
                    disabled={positions.length === 0}
                >
                    Exit All Positions
                </button>
                <span className="grand-total">
                    Total available: <strong>{grandTotalDisplay} AFHO</strong>
                </span>
                {vestingCount > 0 && (
                    <span className="vesting-note">
                        +{vestingTotal.toFixed(4)} AFHO locked in vesting bond positions — becomes claimable at end of vesting
                    </span>
                )}
            </div>

            <div className="pos-contain">
                {displayPositions.map((pos) => {
                    const daysRemaining = getDaysRemaining(pos as typeof positions[number]);
                    const isVesting = daysRemaining > 0;
                    const isBond = pos.daysToUnlock > 0;
                    return (
                        <div key={pos.index} className={`position-card neon-glitch glass-pane ${isVesting ? 'vesting' : ''}`}>
                            <div className="position-row">
                                <span><strong>{(pos.amount / 1e9).toFixed(2)} </strong> AFHO</span>
                                <div className="position-badges">
                                    {isBond && (
                                        <span className="bond-badge neon-glitch" title="Purchased via night-desk bond offer">
                                            Bond
                                        </span>
                                    )}
                                    {'multiplierDisplay' in pos && pos.multiplierDisplay !== '—' && (
                                        <span className="multiplier-badge">{pos.multiplierDisplay}x</span>
                                    )}
                                </div>
                            </div>
                            {isVesting && (
                                <div className="vesting-countdown">
                                    <span className="countdown-number">{daysRemaining}</span>
                                    <span className="countdown-label">
                                        trading day{daysRemaining === 1 ? '' : 's'} to unlock
                                    </span>
                                </div>
                            )}
                            <div><strong>Entry Day:</strong> #{pos.entryTradingDay}</div>
                            {'tradingDays' in pos && pos.tradingDays > 0 && (
                                <div><strong>Trading Days Elapsed:</strong> {pos.tradingDays}</div>
                            )}
                            {'netRewardDisplay' in pos && pos.netRewardDisplay !== '—' ? (
                                <>
                                    <div className="reward-line">
                                        <strong>Available Reward:</strong> {pos.netRewardDisplay}
                                    </div>
                                    {'penaltyRaw' in pos && pos.penaltyRaw > 0 && (
                                        <div className="penalty-warning">
                                            !! Market penalty: –{pos.penaltyRaw.toFixed(4)} AFHO
                                        </div>
                                    )}
                                    {'posrTaxRaw' in pos && pos.posrTaxRaw > 0 && (
                                        <div className="posr-line">
                                            Protocol tax: –{pos.posrTaxRaw.toFixed(4)} AFHO
                                        </div>
                                    )}
                                </>
                            ) : (
                                <div>Calculating rewards…</div>
                            )}
                            <div><strong>Last Claim:</strong> {new Date(pos.lastClaimTimestamp * 1000).toLocaleDateString()}</div>

                            <button
                                className="unstake"
                                onClick={() => handleUnstake(pos)}
                                disabled={unstakeLoadingIndex === pos.index}
                            >
                                {unstakeLoadingIndex === pos.index
                                    ? 'Exiting…'
                                    : `Exit Position (${exitPenaltyPct}% penalty)`}
                            </button>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
