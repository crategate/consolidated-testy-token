import { useState } from 'react';
import { formatSol, formatTokens, lamportsForCost, pricePerToken, quoteCostRaw, effectivePrice } from '../../hooks/amm/offerMath.ts';
import type { OfferTierData } from '../../hooks/amm/useAmmData.ts';

interface SingleOfferProps {
    offer: OfferTierData;
    qty: number;
    livePrice: bigint | null;
    floorBasis: bigint;
    currency: 'usdc' | 'sol';
    solPrice: bigint | null;
    afhoDecimals: number;
    disabled: boolean;
    onQtyChange: (qty: number) => void;
}

export default function SingleOffer({
    offer,
    qty,
    livePrice,
    floorBasis,
    currency,
    solPrice,
    afhoDecimals,
    disabled,
    onQtyChange,
}: SingleOfferProps) {
    const soldOut = offer.remaining === 0;
    const selected = qty > 0;

    // Local draft while the quantity input is focused: typing lands in the
    // draft, and the committed quantity updates on blur / Enter, clamped to
    // the tier's remaining lots. Clicking +/- blurs the input first, so the
    // buttons always operate on the committed value.
    const [draft, setDraft] = useState<string | null>(null);
    const commitDraft = () => {
        if (draft === null) return;
        setDraft(null);
        const parsed = Number.parseInt(draft, 10);
        if (Number.isNaN(parsed)) return; // revert to the committed qty
        onQtyChange(Math.min(Math.max(parsed, 0), offer.remaining));
    };

    // Approximate per-lot price in the SELECTED payment currency — the final
    // price is fixed on-chain at claim time from the same pool read this
    // estimate uses. Sums the closed-session bonus so the estimate matches
    // the on-chain quote. SOL mirrors the claim handler's own conversion
    // (lamportsForCost: cost × 1.0025 headroom / SOL price).
    let perLot: string | null = null;
    let perLotUnit = 'USDC';
    if (livePrice !== null && livePrice > 0n) {
        if (currency === 'sol' && solPrice !== null && solPrice > 0n) {
            const usdcRaw = quoteCostRaw(
                livePrice, offer.discountBps + offer.bonusBps, floorBasis, offer.lotTier, 1, afhoDecimals,
            );
            perLot = formatSol(lamportsForCost(usdcRaw, solPrice));
            perLotUnit = 'SOL';
        } else if (currency === 'usdc') {
            const eff = effectivePrice(livePrice, offer.discountBps + offer.bonusBps, floorBasis);
            const usd = pricePerToken(eff) * offer.lotTokens;
            perLot = usd >= 1
                ? usd.toLocaleString('en-US', { maximumFractionDigits: 2 })
                : usd.toPrecision(3);
        }
    }

    const excite = qty > 0 ? Math.min(1 + (qty - 1) * 0.35, 2.4) : 1;

    return (
        <article
            className={`offer-card glass-pane ${selected ? 'selected' : ''} ${soldOut ? 'sold-out' : ''}`}
            data-tier={offer.tier}
            style={{
                '--tier-excite': String(excite),
                '--glitch-delay': `${(offer.tier * 1.35 + 0.4).toFixed(2)}s`,
            } as React.CSSProperties}
        >
            <header className="offer-card-header">
                <h3>{offer.label}</h3>
                <span className="offer-discount">{offer.discountBps / 10}% off</span>
            </header>
            {offer.bonusBps > 0 && (
                <div className="offer-bonus-row">
                    <span className="offer-discount offer-discount--bonus">+0.5% late nite bonus</span>
                </div>
            )}

            <div className="offer-lot-size">
                {formatTokens(offer.lotTokens)} <span>AFHO / lot</span>
            </div>

            <dl className="offer-facts">
                <div>
                    <dt>Vesting</dt>
                    <dd>{offer.vestingDays} trading days</dd>
                </div>
                <div>
                    <dt>Remaining</dt>
                    <dd>{offer.remaining} / {offer.totalOffered} lots</dd>
                </div>
                <div>
                    <dt>≈ Price / lot</dt>
                    <dd>{perLot !== null ? `${perLot} ${perLotUnit}` : '—'}</dd>
                </div>
            </dl>

            <div className="qty-stepper" aria-label={`${offer.label} quantity`}>
                <button
                    type="button"
                    onClick={() => onQtyChange(qty - 1)}
                    disabled={disabled || qty === 0}
                    aria-label="decrease"
                >
                    −
                </button>
                <input
                    type="number"
                    className="qty-input"
                    min={0}
                    max={offer.remaining}
                    value={draft ?? qty}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitDraft}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
                    }}
                    disabled={disabled || soldOut}
                    aria-label={`${offer.label} quantity input`}
                />
                <button
                    type="button"
                    onClick={() => onQtyChange(qty + 1)}
                    disabled={disabled || soldOut || qty >= offer.remaining}
                    aria-label="increase"
                >
                    +
                </button>
            </div>
            {soldOut && <p className="offer-soldout">Sold out for today</p>}
        </article>
    );
}
