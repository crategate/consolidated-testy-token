import SingleOffer from './singleOffer.tsx';
import type { OfferTierData } from '../../hooks/amm/useAmmData.ts';

interface SizedOffersProps {
    tiers: OfferTierData[];
    quantities: Record<string, number>;
    livePrice: bigint | null;
    floorBasis: bigint;
    afhoDecimals: number;
    usdcDecimals: number;
    disabled: boolean;
    onQtyChange: (tierKey: string, qty: number) => void;
}

export default function SizedOffers({
    tiers,
    quantities,
    livePrice,
    floorBasis,
    afhoDecimals,
    usdcDecimals,
    disabled,
    onQtyChange,
}: SizedOffersProps) {
    return (
        <div className="offer-grid">
            {tiers.map((offer) => (
                <SingleOffer
                    key={offer.key}
                    offer={offer}
                    qty={quantities[offer.key] ?? 0}
                    livePrice={livePrice}
                    floorBasis={floorBasis}
                    afhoDecimals={afhoDecimals}
                    usdcDecimals={usdcDecimals}
                    disabled={disabled}
                    onQtyChange={(q) => onQtyChange(offer.key, q)}
                />
            ))}
        </div>
    );
}
