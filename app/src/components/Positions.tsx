import React from 'react';
import { usePositions } from '../hooks/usePositions';
import { usePositionRewards } from '../hooks/usePositionRewards';
import { useClaimAll } from '../hooks/useClaimAll';
import { PublicKey } from '@solana/web3.js';

interface PositionsProps {
    mint: PublicKey;
    marketStatusPda?: PublicKey;
}

export const Positions: React.FC<PositionsProps> = ({ mint, marketStatusPda }) => {
    const { positions, loading: positionsLoading, refresh: refreshPositions } = usePositions(mint);
    const { enriched, grandTotal } = usePositionRewards(mint, positions);
    const { claimAll, loading: claimLoading } = useClaimAll(mint, positions, marketStatusPda);

    const handleClaimAll = async () => {
        try {
            const tx = await claimAll();
            alert(`All claims collected successfully! Tx: ${tx}`);
            refreshPositions();
        } catch (e) {
            alert('Failed to collect claims: ' + (e as Error).message);
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
                    disabled={claimLoading || grandTotal <= 0}
                >
                    {claimLoading ? 'Collecting…' : 'Collect Claims'}
                </button>
                <span className="grand-total">
                    Total available: <strong>{grandTotalDisplay} NYSEH</strong>
                </span>
            </div>

            {displayPositions.map((pos) => (
                <div key={pos.index} className="position-card">
                    <div className="position-row">
                        <span><strong>Amount:</strong> {(pos.amount / 1e9).toFixed(2)} NYSEH</span>
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
                            {'penaltyRaw' in pos && (pos as any).penaltyRaw > 0 && (
                                <div className="penalty-warning">
                                    ⚠️ Market penalty: –{(pos as any).penaltyRaw.toFixed(4)} NYSEH
                                </div>
                            )}
                            {'posrTaxRaw' in pos && (pos as any).posrTaxRaw > 0 && (
                                <div className="posr-line">
                                    Protocol tax: –{(pos as any).posrTaxRaw.toFixed(4)} NYSEH
                                </div>
                            )}
                        </>
                    ) : (
                        <div>Calculating rewards…</div>
                    )}
                    <div><strong>Last Claim:</strong> {new Date(pos.lastClaimTimestamp * 1000).toLocaleDateString()}</div>

                    <button className="unstake">Exit Position</button>
                </div>
            ))}
        </div>
    );
};
