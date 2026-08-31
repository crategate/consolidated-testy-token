import { formatTokens, pricePerToken, effectivePrice } from '../../hooks/amm/offerMath.ts';
import type { OfferTierData } from '../../hooks/amm/useAmmData.ts';

interface SingleOfferProps {
    offer: OfferTierData;
    qty: number;
    livePrice: bigint | null;
    floorBasis: bigint;
    afhoDecimals: number;
    usdcDecimals: number;
    disabled: boolean;
    onQtyChange: (qty: number) => void;
}

export default function SingleOffer({
    offer,
    qty,
    livePrice,
    floorBasis,
    afhoDecimals,
    usdcDecimals,
    disabled,
    onQtyChange,
}: SingleOfferProps) {
    const soldOut = offer.remaining === 0;
    const selected = qty > 0;

    // Approximate per-lot price in USDC — the final price is fixed on-chain
    // at claim time from the same oracle read this estimate uses.
    let perLot: string | null = null;
    if (livePrice !== null && livePrice > 0n) {
        const eff = effectivePrice(livePrice, offer.discountBps, floorBasis);
        const usd = pricePerToken(eff, afhoDecimals, usdcDecimals) * offer.lotTokens;
        perLot = usd >= 1
            ? usd.toLocaleString('en-US', { maximumFractionDigits: 2 })
            : usd.toPrecision(3);
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
                    <dd>{perLot !== null ? `${perLot} USDC` : '—'}</dd>
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
                <span className="qty-value">{qty}</span>
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
