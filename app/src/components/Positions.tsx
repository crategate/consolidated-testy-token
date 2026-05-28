import React from 'react';
import { usePositions } from '../hooks/usePositions';
import { PublicKey } from '@solana/web3.js';

interface PositionsProps {
    mint: PublicKey;
}

export const Positions: React.FC<PositionsProps> = ({ mint }) => {
    const { positions, loading } = usePositions(mint);

    if (loading) return <div>Loading positions…</div>;
    if (positions.length === 0) return <div className="no-positions">No active stakes.</div>;

    return (
        <div className="positions-list">
            <h3>Your Positions</h3>
            {positions.map((pos) => (
                <div key={pos.index} className="position-card">
                    <div><strong>Amount:</strong> {pos.amount / 1e9} NYSEH</div>
                    <div><strong>Entry Day:</strong> #{pos.entryTradingDay}</div>
                    <div><strong>Last Claim:</strong> {new Date(pos.lastClaimTimestamp * 1000).toLocaleDateString()}</div>
                </div>
            ))}
        </div>
    );
};
