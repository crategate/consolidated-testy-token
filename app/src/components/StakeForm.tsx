import { useState, useEffect } from 'react';
import { useStake } from '../hooks/stake/useStake';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

interface StakeFormProps {
    mint: PublicKey;
    marketStatusPda?: PublicKey;
    onStakeSuccess?: () => void;
}

export function StakeForm({ mint, marketStatusPda, onStakeSuccess }: StakeFormProps) {
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
            setTimeout(() => onStakeSuccess?.(), 2000);
        } catch (e) {
            alert('Stake failed: ' + (e as Error).message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="stake-form stake-card">
            <h3>Stake NYSEH</h3>
            <div className="mint-display">
                Mint: <br /><code>{mint.toBase58().slice(0, 8)}…{mint.toBase58().slice(-8)}</code>
            </div>
            <div className="balance-line">
                {balance !== null ? balance.toFixed(4) : '—'} <span>NYSEH</span>
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
        </div >
    );
};