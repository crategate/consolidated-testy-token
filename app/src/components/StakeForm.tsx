import React, { useState } from 'react';
import { useStake } from '../hooks/useStake';
import { PublicKey } from '@solana/web3.js';

interface StakeFormProps {
    mint: PublicKey;
}

export const StakeForm: React.FC<StakeFormProps> = ({ mint }) => {
    const { stake } = useStake(mint);
    const [amount, setAmount] = useState('');
    const [loading, setLoading] = useState(false);

    const handleStake = async () => {
        if (!amount) return;
        setLoading(true);
        try {
            const tx = await stake(amount);
            alert(`Staked successfully! Tx: ${tx}`);
            setAmount('');
        } catch (e) {
            alert('Stake failed: ' + (e as Error).message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="stake-form">
            <h3>Stake NYSEH</h3>
            <p className="custodial-note">
                Tokens move into the program vault and no longer appear in your wallet.
                Your stake is tracked by an on-chain position account.
            </p>
            <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="Amount to stake"
                disabled={loading}
            />
            <button onClick={handleStake} disabled={loading || !amount}>
                {loading ? 'Staking…' : 'Stake'}
            </button>
        </div>
    );
};
