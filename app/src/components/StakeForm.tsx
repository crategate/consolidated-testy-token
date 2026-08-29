import { useState } from 'react';
import { useStake } from '../hooks/stake/useStake';
import { useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { useTokenBalance } from '../hooks/useTokenBalance';

interface StakeFormProps {
    mint: PublicKey;
    marketStatusPda?: PublicKey;
    onStakeSuccess?: () => void;
}

export function StakeForm({ mint, marketStatusPda, onStakeSuccess }: StakeFormProps) {
    const { stake } = useStake(mint, marketStatusPda);
    const { connected, publicKey } = useWallet();
    const { balance, refresh: refreshBalance } = useTokenBalance(mint, publicKey, 9);
    const [amount, setAmount] = useState('');
    const [loading, setLoading] = useState(false);

    const handleStake = async () => {
        if (!amount) return;
        setLoading(true);
        try {
            const tx = await stake(amount);
            alert(`Staked successfully! Tx: ${tx}`);
            setAmount('');
            void refreshBalance();
            setTimeout(() => onStakeSuccess?.(), 2000);
        } catch (e) {
            alert('Stake failed: ' + (e as Error).message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div
            className={`stake-form stake-card rainbow-glow neon-shadow ${connected ? 'connected' : ''}`}
            style={{ '--shadow-delay': '0.4s' } as React.CSSProperties}
        >
            <h3>Stake AFHO</h3>
            <div className="mint-display">
                Mint: <br /><code>{mint.toBase58().slice(0, 8)}…{mint.toBase58().slice(-8)}</code>
            </div>
            <div className="balance-line">
                {balance !== null ? balance.toFixed(4) : '—'} <span>AFHO</span>
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
