import { useEffect, useRef, useState } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { useAmmData, type OfferTierData } from '../../hooks/amm/useAmmData.ts';
import { useOfferClaim, type ClaimCurrency } from '../../hooks/amm/useOfferClaim.ts';
import {
    formatSol,
    formatTokens,
    formatUsdc,
    lamportsForCost,
    pricePerToken,
    quoteCostRaw,
    ratchetActive,
} from '../../hooks/amm/offerMath.ts';
import SizedOffers from './SizedOffers.tsx';
import { GlitchText } from '../GlitchText.tsx';

const PERCENT_STEPS = [25, 50, 75] as const;

function deskMessage(state: number | null, sheetStale: boolean, offersLive: boolean): string {
    if (state === 0) return 'Desk opens after market close — check back at the end of the trading day.';
    if (state === 3) return 'Market halted — the offer desk is closed.';
    if (state === 1 || state === 2) {
        if (sheetStale) return "Tonight's offer sheet hasn't posted yet — check back shortly after close.";
        if (!offersLive) return "No offers on tonight's sheet — check back at the end of the next trading day.";
    }
    return '';
}

export default function OfferLists() {
    const data = useAmmData();
    const { connected, publicKey } = useWallet();
    const { connection } = useConnection();
    const { claim, status, txSig, error: claimError, reset } = useOfferClaim(
        data.accounts,
        data.solAccounts,
        data.usdcDecimals,
    );
    const { setVisible } = useWalletModal();
    const [quantities, setQuantities] = useState<Record<string, number>>({ big: 0, med: 0, sml: 0 });
    const [currency, setCurrency] = useState<ClaimCurrency>('usdc');
    const [menuOpen, setMenuOpen] = useState(false);
    const [balances, setBalances] = useState<{ usdc: bigint | null; sol: bigint | null }>({ usdc: null, sol: null });
    const pickerRef = useRef<HTMLDivElement>(null);

    // Clamp quantities if the sheet refreshes with fewer remaining lots
    useEffect(() => {
        setQuantities((prev) => {
            const next = { ...prev };
            for (const t of data.tiers) {
                if ((next[t.key] ?? 0) > t.remaining) next[t.key] = t.remaining;
            }
            return next;
        });
    }, [data.tiers]);

    // Buyer's spendable balances for the % quick-fill buttons. Own 15s cadence
    // (not tied to the 30s price poll) to spare the rate-limited devnet RPC.
    useEffect(() => {
        let cancelled = false;
        const fetchBalances = async () => {
            if (!publicKey || !data.accounts) {
                setBalances({ usdc: null, sol: null });
                return;
            }
            try {
                const buyerUsdc = getAssociatedTokenAddressSync(data.accounts.usdcMint, publicKey, false, TOKEN_PROGRAM_ID);
                const [lamports, usdc] = await Promise.all([
                    connection.getBalance(publicKey),
                    getAccount(connection, buyerUsdc, 'confirmed', TOKEN_PROGRAM_ID).catch(() => null),
                ]);
                if (!cancelled) {
                    setBalances({ usdc: usdc ? usdc.amount : 0n, sol: BigInt(lamports) });
                }
            } catch {
                if (!cancelled) setBalances({ usdc: null, sol: null });
            }
        };
        void fetchBalances();
        const interval = window.setInterval(() => {
            if (!document.hidden) void fetchBalances();
        }, 15000);
        return () => { cancelled = true; window.clearInterval(interval); };
    }, [connection, publicKey, data.accounts]);

    // Close the currency menu on any outside click.
    useEffect(() => {
        if (!menuOpen) return;
        const onDown = (e: MouseEvent) => {
            if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setMenuOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [menuOpen]);

    const setQty = (tierKey: string, qty: number) => {
        if (status !== 'idle') reset();
        setQuantities((prev) => ({ ...prev, [tierKey]: Math.max(0, qty) }));
    };

    const selections = data.tiers
        .filter((t) => (quantities[t.key] ?? 0) > 0)
        .map((t) => ({ tier: t.tier, units: quantities[t.key] }));

    const totalLots = selections.reduce((n, s) => n + s.units, 0);
    const totalTokens = data.tiers.reduce(
        (n, t) => n + (quantities[t.key] ?? 0) * t.lotTokens, 0
    );
    const estCostRaw = data.tiers.reduce(
        (sum, t) => sum + quoteCostRaw(
            data.livePrice ?? 0n, t.discountBps, data.floorBasis,
            t.lotTier, quantities[t.key] ?? 0, data.afhoDecimals,
        ),
        0n,
    );

    const priceKnown = data.livePrice !== null && data.livePrice > 0n;
    const solPriceKnown = data.solPrice !== null && data.solPrice > 0n;
    const ratchet = priceKnown && data.tiers.some(
        (t) => (quantities[t.key] ?? 0) > 0 && ratchetActive(data.livePrice as bigint, t.discountBps, data.floorBasis)
    );

    // Per-lot cost in the SELECTED currency (SOL estimates use the same
    // lamports math the on-chain handler applies at claim time).
    const costPerLot = (t: OfferTierData): bigint => {
        const c = quoteCostRaw(data.livePrice ?? 0n, t.discountBps, data.floorBasis, t.lotTier, 1, data.afhoDecimals);
        return currency === 'usdc' ? c : lamportsForCost(c, data.solPrice ?? 0n);
    };

    const solReady = data.solAccounts !== null && solPriceKnown;

    const canBuy = connected && data.deskOpen && totalLots > 0 && priceKnown &&
        status !== 'pending' && (currency === 'usdc' ? data.accounts !== null : solReady);

    const buyLabel = !connected
        ? 'Connect wallet to buy'
        : !data.deskOpen
            ? 'Desk closed'
            : status === 'pending'
                ? 'Claiming…'
                : 'Buy selected offers';

    const handleBuy = async () => {
        const ok = await claim(selections, estCostRaw, { currency, solPrice: data.solPrice });
        if (ok) setQuantities({ big: 0, med: 0, sml: 0 });
        setTimeout(data.refresh, 2000);
    };

    const selectCurrency = (next: ClaimCurrency) => {
        if (status !== 'idle') reset();
        setCurrency(next);
        setMenuOpen(false);
    };

    // Quick-fill: pick a combination of whole lots whose total cost is the
    // largest amount not exceeding pct% of the selected wallet balance. This is
    // a small bounded knapsack (3 tiers), so a brute-force search is exact and
    // fast enough for a button click.
    const applyPercent = (pct: number) => {
        if (!priceKnown) return;
        const bal = currency === 'usdc' ? balances.usdc : balances.sol;
        if (bal === null || bal <= 0n) return;
        const target = (bal * BigInt(pct)) / 100n;

        const byKey = (key: string) => data.tiers.find((t) => t.key === key);
        const big = byKey('big');
        const med = byKey('med');
        const sml = byKey('sml');
        const bigCost = big ? costPerLot(big) : 0n;
        const medCost = med ? costPerLot(med) : 0n;
        const smlCost = sml ? costPerLot(sml) : 0n;

        const maxCount = (tier: OfferTierData | undefined, perLot: bigint): number => {
            if (!tier || perLot <= 0n) return 0;
            return Math.min(tier.remaining, Number(target / perLot));
        };

        const bigMax = maxCount(big, bigCost);
        const medMax = maxCount(med, medCost);

        let bestCost = 0n;
        const best: Record<string, number> = { big: 0, med: 0, sml: 0 };

        for (let b = 0; b <= bigMax; b++) {
            const costB = bigCost * BigInt(b);
            if (costB > target) break;
            for (let m = 0; m <= medMax; m++) {
                const costBM = costB + medCost * BigInt(m);
                if (costBM > target) break;
                const remaining = target - costBM;
                const smlMax = sml ? Math.min(sml.remaining, Number(remaining / smlCost)) : 0;
                // For this (big, med) pair the best sml count is the most that
                // still fits; scanning a couple below catches near-target ties
                // without noticeably increasing work.
                for (let s = Math.max(0, smlMax - 1); s <= smlMax; s++) {
                    const cost = costBM + smlCost * BigInt(s);
                    if (cost <= target && cost > bestCost) {
                        bestCost = cost;
                        best.big = b;
                        best.med = m;
                        best.sml = s;
                    }
                }
            }
        }

        if (status !== 'idle') reset();
        setQuantities(best);
    };

    const closedMessage = deskMessage(data.marketState, data.sheetStale, data.offersLive);

    // Tiles exist only inside the desk's night window with tonight's sheet
    // posted. Market open / halted (or a stale sheet) = desk closed → tiles
    // hidden. Sold out during the night = tiles stay up, greyed via each
    // tier's sold-out state (remaining reads 0 / N).
    const night = data.marketState === 1 || data.marketState === 2;
    const showTiles = night && !data.sheetStale && data.tiers.length > 0;

    const displayCost = totalLots > 0 && priceKnown
        ? currency === 'usdc'
            ? `≈ ${formatUsdc(estCostRaw, data.usdcDecimals)}`
            : solPriceKnown
                ? `≈ ${formatSol(lamportsForCost(estCostRaw, data.solPrice as bigint))}`
                : '—'
        : '—';

    const balanceLabel = currency === 'usdc'
        ? balances.usdc !== null ? `Balance: ${formatUsdc(balances.usdc, data.usdcDecimals)} USDC` : ''
        : balances.sol !== null ? `Balance: ${formatSol(balances.sol)} SOL` : '';

    return (
        <section className="offer-desk">
            {data.error && <div className="desk-banner error glass-pane">RPC error: {data.error} — showing last known state</div>}
            {data.loading && !data.tiers.length && <div className="desk-banner glass-pane">Loading offer sheet…</div>}

            {!data.loading && !data.deskOpen && closedMessage && (
                <div className="desk-banner closed glass-pane">{closedMessage}</div>
            )}
            {data.deskOpen && (
                <div className="desk-banner open glass-pane">
                    Desk open — purchased AFHO goes straight into a vesting stake position, not your wallet.
                </div>
            )}

            {showTiles && (
                <SizedOffers
                    tiers={data.tiers}
                    quantities={quantities}
                    livePrice={data.livePrice}
                    floorBasis={data.floorBasis}
                    afhoDecimals={data.afhoDecimals}
                    usdcDecimals={data.usdcDecimals}
                    disabled={!data.deskOpen || status === 'pending'}
                    onQtyChange={setQty}
                />
            )}

            <div
                className="order-bar glass-pane"
                data-order={totalLots > 0 ? 'active' : 'idle'}
                style={{ '--order-excite': String(Math.min(1 + totalLots * 0.18, 2.6)) } as React.CSSProperties}
            >
                <div className="order-total">
                    <span className="order-total-label"><GlitchText text="Total order size (approx.)" variant="light" split="letter" step={0.3} /></span>
                    <div className="order-total-line">
                        <strong>{displayCost}</strong>
                        <div className="currency-picker" ref={pickerRef}>
                            <button
                                type="button"
                                className="currency-select"
                                onClick={() => setMenuOpen((o) => !o)}
                                aria-haspopup="listbox"
                                aria-expanded={menuOpen}
                            >
                                {currency === 'usdc' ? 'USDC' : 'SOL'}
                                <span className="currency-caret">▾</span>
                            </button>
                            {menuOpen && (
                                <div className="currency-menu" role="listbox">
                                    <button
                                        type="button"
                                        className="currency-option"
                                        role="option"
                                        aria-selected={currency === 'usdc'}
                                        onClick={() => selectCurrency('usdc')}
                                    >
                                        USDC
                                        {currency === 'usdc' && <span className="hint">selected</span>}
                                    </button>
                                    <button
                                        type="button"
                                        className="currency-option"
                                        role="option"
                                        aria-selected={currency === 'sol'}
                                        disabled={!data.solAccounts}
                                        title={data.solAccounts ? undefined : 'SOL payments need the SOL/USDC pool pinned (anchor run set-sol-usdc-pool)'}
                                        onClick={() => selectCurrency('sol')}
                                    >
                                        SOL
                                        {currency === 'sol'
                                            ? <span className="hint">selected</span>
                                            : !data.solAccounts && <span className="hint">pool not pinned</span>}
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="pct-row">
                        {PERCENT_STEPS.map((pct) => (
                            <button
                                key={pct}
                                type="button"
                                className="pct-btn"
                                disabled={!priceKnown || (currency === 'usdc' ? balances.usdc === null || balances.usdc <= 0n : balances.sol === null || balances.sol <= 0n)}
                                onClick={() => applyPercent(pct)}
                            >
                                {pct}%
                            </button>
                        ))}
                        {balanceLabel && <span className="order-balance">{balanceLabel}</span>}
                    </div>
                    {totalLots > 0 && (
                        <span className="order-total-sub">
                            {formatTokens(totalTokens)} AFHO · {totalLots} lot{totalLots !== 1 ? 's' : ''}
                            {ratchet && ' · buyback-floor ratchet active'}
                        </span>
                    )}
                    {priceKnown && (
                        <span className="order-live-price">
                            Live AFHO ≈ ${(() => {
                                const px = pricePerToken(data.livePrice as bigint, data.afhoDecimals, data.usdcDecimals);
                                return px >= 1 ? px.toLocaleString('en-US', { maximumFractionDigits: 4 }) : px.toPrecision(4);
                            })()}{' '}
                            · source: {data.accounts ? 'pool (spot)' : 'oracle'}
                            {data.updatedAt && ` · updated ${Math.max(0, Math.round((Date.now() - new Date(data.updatedAt).getTime()) / 1000))}s ago`}
                        </span>
                    )}
                </div>
                <button
                    type="button"
                    className={`buy-button${!connected ? ' needs-wallet' : ''}${totalLots > 0 ? ' has-order' : ''}${canBuy ? ' ready' : ''}`}
                    onClick={() => {
                        if (!connected) {
                            setVisible(true);
                            return;
                        }
                        void handleBuy();
                    }}
                    disabled={connected && !canBuy}
                >
                    <GlitchText text={buyLabel} variant="light" split="letter" step={0.3} />
                </button>
            </div>
            <p className="order-note">
                <GlitchText
                    text="Estimate only — the live oracle price at claim time sets the final cost. Payment splits 80% buybacks / 10% dip reserve / 10% staker rewards."
                    variant="light"
                    split="word"
                    step={0.12}
                />
                {currency === 'sol' && ' SOL payments swap to USDC at claim (you cover the 0.25% pool fee).'}
            </p>

            {status === 'success' && txSig && (
                <div className="desk-banner success glass-pane">
                    Claim submitted — AFHO is vesting in your stake positions.{' '}
                    <a href={`https://explorer.solana.com/tx/${txSig}?cluster=devnet`} target="_blank" rel="noreferrer">
                        View transaction
                    </a>
                </div>
            )}
            {status === 'error' && claimError && (
                <div className="desk-banner error glass-pane">Claim failed: {claimError}</div>
            )}
        </section>
    );
}
