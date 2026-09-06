import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import BN from 'bn.js';
import { useStake, parseAmountToRawBN } from '../hooks/stake/useStake';
import { useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { useTokenBalance } from '../hooks/useTokenBalance';
import { useChainData } from '../context/useChainData';
import { GlitchText } from './GlitchText.tsx';

const TOKEN_DECIMALS = 9;
const PERCENT_STEPS = [25, 50, 75] as const;

/** Raw u64 base units → plain decimal token string (9 dp, trailing zeros
    stripped). BigInt math so a filled amount can never round above the
    wallet's true balance. */
function rawToAmountString(raw: bigint, decimals: number): string {
    const base = 10n ** BigInt(decimals);
    const whole = raw / base;
    const frac = (raw % base).toString().padStart(decimals, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole.toString();
}

interface StakeFormProps {
    mint: PublicKey;
    marketStatusPda?: PublicKey;
    onStakeSuccess?: () => void;
}

export function StakeForm({ mint, marketStatusPda, onStakeSuccess }: StakeFormProps) {
    const { stake } = useStake(mint, marketStatusPda);
    const { connected, publicKey } = useWallet();
    const { balance, rawBalance, refresh: refreshBalance } = useTokenBalance(mint, publicKey, TOKEN_DECIMALS);
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

    /* Quick-fill: 25/50/75% and MAX of the wallet's AFHO balance, computed
       from the raw u64 so the inserted amount always stakes exactly. */
    const fillFromBalance = (pct: number) => {
        if (rawBalance === null) return;
        const raw = pct >= 100 ? rawBalance : (rawBalance * BigInt(pct)) / 100n;
        setAmount(rawToAmountString(raw, TOKEN_DECIMALS));
    };

    const fillDisabled = rawBalance === null || rawBalance === 0n;

    /* Exact over-balance check (raw bigint, not floats — Number(amount) and
       the balance float can differ by an ulp at devnet scale, which would
       wrongly disable staking right after a MAX fill). Falls back to the
       float compare for inputs the exact parser rejects. */
    const amountExceedsBalance = (() => {
        if (amount === '') return false;
        if (rawBalance !== null) {
            try {
                return parseAmountToRawBN(amount, TOKEN_DECIMALS).gt(new BN(rawBalance.toString()));
            } catch {
                /* fall through to float compare */
            }
        }
        return balance !== null && Number(amount) > balance;
    })();

    /* Step ladder: the form's effects grow slightly more excited as the
       staking process completes — empty (idle) → typing → ready. */
    const step = !amount
        ? 'idle'
        : amountExceedsBalance
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
            <div className="pct-row" role="group" aria-label="Quick fill from balance">
                {PERCENT_STEPS.map((pct) => (
                    <button
                        key={pct}
                        type="button"
                        className="pct-btn"
                        disabled={fillDisabled}
                        onClick={() => fillFromBalance(pct)}
                    >
                        {pct}%
                    </button>
                ))}
                <button
                    type="button"
                    className="pct-btn"
                    disabled={fillDisabled}
                    onClick={() => fillFromBalance(100)}
                >
                    MAX
                </button>
            </div>
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
            <button onClick={handleStake} disabled={loading || !amount || amountExceedsBalance}>
                {loading ? 'Staking…' : 'Stake'}
            </button>
        </div>
    );
};
