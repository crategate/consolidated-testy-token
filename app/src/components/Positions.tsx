import { usePositions } from '../hooks/stake/usePositions';
import { usePositionRewards } from '../hooks/stake/usePositionRewards';
import { useClaimAll } from '../hooks/stake/useClaimAll';
import { useMarketStatus } from '../hooks/useMarketStatus';
import { useUnstake } from '../hooks/stake/useUnstake';
import { PublicKey } from '@solana/web3.js';

interface PositionsProps {
    mint: PublicKey;
    marketStatusPda?: PublicKey;
}

export function Positions({ mint, marketStatusPda }: PositionsProps) {
    const { positions, loading: positionsLoading, refresh: refreshPositions } = usePositions(mint);
    const { data: marketData } = useMarketStatus(marketStatusPda);
    const { enriched, grandTotal } = usePositionRewards(mint, positions, marketStatusPda);
    const { claimAll, loading: claimLoading } = useClaimAll(mint, positions, marketStatusPda);
    const { unstake, loadingIndex: unstakeLoadingIndex } = useUnstake(mint, marketStatusPda, marketData?.state);
    const claimsOpen = marketData?.state === 0;

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

    if (positionsLoading && !positions.length) return <div>Loading positions…</div>;
    if (positions.length === 0) return <div className="no-positions">No active stakes.</div>;

    const displayPositions = enriched.length > 0 ? enriched : positions.map(p => ({
        ...p,
        multiplierDisplay: '—',
        tradingDays: 0,
        netRewardDisplay: '—',
        penaltyRaw: 0,
        posrTaxRaw: 0,
    }));

    const grandTotalDisplay = (grandTotal).toFixed(4);

    return (
        <div className="positions-list">
            <h3>Your Positions</h3>

            <div className="claims-header">
                <button
                    className="claim-collect"
                    onClick={handleClaimAll}
                    disabled={!claimsOpen || claimLoading || grandTotal <= 0}
                >
                    {!claimsOpen ? 'Claim Available After Opening Bell' : claimLoading ? 'Collecting…' : 'Collect All Claims'}
                </button>
                <span className="grand-total">
                    Total available: <strong>{grandTotalDisplay} NYSEH</strong>
                </span>
            </div>

            <div className="pos-contain">
                {displayPositions.map((pos) => (
                    <div key={pos.index} className="position-card">
                        <div className="position-row">
                            <span><strong>{(pos.amount / 1e9).toFixed(2)} </strong> NYSEH</span>
                            {'multiplierDisplay' in pos && pos.multiplierDisplay !== '—' && (
                                <span className="multiplier-badge">{pos.multiplierDisplay}x</span>
                            )}
                        </div>
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
                                        ⚠️ Market penalty: –{pos.penaltyRaw.toFixed(4)} NYSEH
                                    </div>
                                )}
                                {'posrTaxRaw' in pos && pos.posrTaxRaw > 0 && (
                                    <div className="posr-line">
                                        Protocol tax: –{pos.posrTaxRaw.toFixed(4)} NYSEH
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
                            {unstakeLoadingIndex === pos.index ? 'Exiting…' : 'Exit Position'}
                        </button>
                    </div>
                ))}
            </div>
        </div >
    );
};
