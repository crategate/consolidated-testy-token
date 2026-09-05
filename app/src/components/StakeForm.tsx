import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useStake } from '../hooks/stake/useStake';
import { useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { useTokenBalance } from '../hooks/useTokenBalance';
import { useChainData } from '../context/useChainData';
import { GlitchText } from './GlitchText.tsx';

interface StakeFormProps {
    mint: PublicKey;
    marketStatusPda?: PublicKey;
    onStakeSuccess?: () => void;
}

export function StakeForm({ mint, marketStatusPda, onStakeSuccess }: StakeFormProps) {
    const { stake } = useStake(mint, marketStatusPda);
    const { connected, publicKey } = useWallet();
    const { balance, refresh: refreshBalance } = useTokenBalance(mint, publicKey, 9);
    const queryClient = useQueryClient();
    const { refresh: refreshChainData } = useChainData();
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
            // The new position appears immediately — no page refresh needed.
            // Invalidate the shared positions query (all mounted list
            // instances) and the chain snapshot (pool totalStaked), then
            // repeat once shortly after to cover devnet RPC lag on the fresh
            // account.
            onStakeSuccess?.();
            void queryClient.invalidateQueries({ queryKey: ['positions'] });
            void refreshChainData('pool');
            setTimeout(() => {
                void queryClient.invalidateQueries({ queryKey: ['positions'] });
            }, 1500);
        } catch (e) {
            alert('Stake failed: ' + (e as Error).message);
        } finally {
            setLoading(false);
        }
    };

    /* Step ladder: the form's effects grow slightly more excited as the
       staking process completes — empty (idle) → typing → ready. */
    const step = !amount
        ? 'idle'
        : balance !== null && Number(amount) > balance
            ? 'typing'
            : 'ready';

    return (
        <div
            className={`stake-form stake-card rainbow-glow neon-shadow glass-pane ${connected ? 'connected' : ''}`}
            data-step={step}
            style={{ '--shadow-delay': '0.4s' } as React.CSSProperties}
        >
            <h3>Lock & Earn AFHO</h3>
            <div className="mint-display">
                Mint: <br /><code>{mint.toBase58().slice(0, 8)}…{mint.toBase58().slice(-8)}</code>
            </div>
            <div className="balance-line">
                {balance !== null ? balance.toFixed(4) : '—'} <span>AFHO</span>
            </div>
            <p className="custodial-note">
                <GlitchText
                    text="Tokens move into the program vault and no longer appear in your wallet. You can see your positions below. Rewards from bond sales & unlock penalties."
                    variant="light"
                    split="word"
                    step={0.3}
                />
            </p>
            <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="Amount to stake"
                disabled={loading}
                max={balance || undefined}
            />
            {Number(amount) >= 9006000 && (
                <p className='stake-penalty-note' role="alert">
                    <span>Max position size 9,006,000</span></p>
            )}
            {amount !== '' && Number(amount) > 0 && (
                <p className="stake-penalty-note" role="alert">
                    <span>
                        Penalty: unlocking your position outside NYSE trading hours
                        (after-hours, closed, or halted) penalizes your principal.
                        Exit while the market is open to avoid it.
                    </span>
                </p>
            )}
            <button onClick={handleStake} disabled={loading || !amount || (balance !== null && Number(amount) > balance)}>
                {loading ? 'Staking…' : 'Stake'}
            </button>
        </div>
    );
};
