import { useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAmmData } from '../../hooks/amm/useAmmData.ts';
import { useOfferClaim } from '../../hooks/amm/useOfferClaim.ts';
import { formatTokens, formatUsdc, quoteCostRaw, ratchetActive } from '../../hooks/amm/offerMath.ts';
import SizedOffers from './SizedOffers.tsx';

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
    const { connected } = useWallet();
    const { claim, status, txSig, error: claimError, reset } = useOfferClaim(data.accounts, data.usdcDecimals);
    const [quantities, setQuantities] = useState<Record<string, number>>({ big: 0, med: 0, sml: 0 });

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
            t.lotTier, quantities[t.key] ?? 0, data.nysehDecimals,
        ),
        0n,
    );

    const priceKnown = data.livePrice !== null && data.livePrice > 0n;
    const ratchet = priceKnown && data.tiers.some(
        (t) => (quantities[t.key] ?? 0) > 0 && ratchetActive(data.livePrice as bigint, t.discountBps, data.floorBasis)
    );

    const canBuy = connected && data.deskOpen && totalLots > 0 && priceKnown &&
        data.accounts !== null && status !== 'pending';

    const buyLabel = !connected
        ? 'Connect wallet to buy'
        : !data.deskOpen
            ? 'Desk closed'
            : status === 'pending'
                ? 'Claiming…'
                : 'Buy selected offers';

    const handleBuy = async () => {
        const ok = await claim(selections, estCostRaw);
        if (ok) setQuantities({ big: 0, med: 0, sml: 0 });
        setTimeout(data.refresh, 2000);
    };

    const closedMessage = deskMessage(data.marketState, data.sheetStale, data.offersLive);

    return (
        <section className="offer-desk">
            {data.error && <div className="desk-banner error">RPC error: {data.error} — showing last known state</div>}
            {data.loading && !data.tiers.length && <div className="desk-banner">Loading offer sheet…</div>}

            {!data.loading && !data.deskOpen && closedMessage && (
                <div className="desk-banner closed">{closedMessage}</div>
            )}
            {data.deskOpen && (
                <div className="desk-banner open">
                    Desk open — purchased NYSEH goes straight into a vesting stake position, not your wallet.
                </div>
            )}

            {data.tiers.length > 0 && (
                <SizedOffers
                    tiers={data.tiers}
                    quantities={quantities}
                    livePrice={data.livePrice}
                    floorBasis={data.floorBasis}
                    nysehDecimals={data.nysehDecimals}
                    usdcDecimals={data.usdcDecimals}
                    disabled={!data.deskOpen || status === 'pending'}
                    onQtyChange={setQty}
                />
            )}

            <div className="order-bar">
                <div className="order-total">
                    <span className="order-total-label">Total order size (approx.)</span>
                    <strong>
                        {totalLots > 0 && priceKnown
                            ? `≈ ${formatUsdc(estCostRaw, data.usdcDecimals)} USDC`
                            : '—'}
                    </strong>
                    {totalLots > 0 && (
                        <span className="order-total-sub">
                            {formatTokens(totalTokens)} NYSEH · {totalLots} lot{totalLots !== 1 ? 's' : ''}
                            {ratchet && ' · buyback-floor ratchet active'}
                        </span>
                    )}
                </div>
                <button
                    type="button"
                    className="buy-button"
                    onClick={handleBuy}
                    disabled={!canBuy}
                >
                    {buyLabel}
                </button>
            </div>
            <p className="order-note">
                Estimate only — the live oracle price at claim time sets the final cost.
                Payment splits 80% buybacks / 10% dip reserve / 10% staker rewards.
            </p>

            {status === 'success' && txSig && (
                <div className="desk-banner success">
                    Claim submitted — NYSEH is vesting in your stake positions.{' '}
                    <a href={`https://explorer.solana.com/tx/${txSig}?cluster=devnet`} target="_blank" rel="noreferrer">
                        View transaction
                    </a>
                </div>
            )}
            {status === 'error' && claimError && (
                <div className="desk-banner error">Claim failed: {claimError}</div>
            )}
        </section>
    );
}
