import React, { useState, useEffect } from 'react';
import { useStake } from '../hooks/useStake';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

interface StakeFormProps {
    mint: PublicKey;
    marketStatusPda?: PublicKey;
}

export const StakeForm: React.FC<StakeFormProps> = ({ mint, marketStatusPda }) => {
    const { stake } = useStake(mint, marketStatusPda);
    const { publicKey } = useWallet();
    const { connection } = useConnection();
    const [amount, setAmount] = useState('');
    const [loading, setLoading] = useState(false);
    const [balance, setBalance] = useState<number | null>(null);

    useEffect(() => {
        if (!publicKey || !connection) return;
        const ata = getAssociatedTokenAddressSync(mint, publicKey, false, TOKEN_2022_PROGRAM_ID);
        getAccount(connection, ata, 'confirmed', TOKEN_2022_PROGRAM_ID)
            .then(acc => setBalance(Number(acc.amount) / 1e9))
            .catch(() => setBalance(0));
    }, [publicKey, connection, mint]);

    const handleStake = async () => {
        if (!amount) return;
        setLoading(true);
        try {
            const tx = await stake(amount);
            alert(`Staked successfully! Tx: ${tx}`);
            setAmount('');
            setBalance(prev => prev !== null ? Math.max(0, prev - Number(amount)) : null);
        } catch (e) {
            alert('Stake failed: ' + (e as Error).message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="stake-form">
            <h3>Stake NYSEH</h3>
            <div style={{ fontSize: '0.875rem', opacity: 0.7, marginBottom: '0.5rem' }}>
                Mint: <code>{mint.toBase58().slice(0, 8)}…{mint.toBase58().slice(-8)}</code>
            </div>
            <div style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '1rem', color: 'var(--text-h)' }}>
                Balance: {balance !== null ? `${balance.toFixed(4)} NYSEH` : 'Loading…'}
            </div>
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
                max={balance || undefined}
            />
            <button onClick={handleStake} disabled={loading || !amount || (balance !== null && Number(amount) > balance)}>
                {loading ? 'Staking…' : 'Stake'}
            </button>
        </div>
    );
};
