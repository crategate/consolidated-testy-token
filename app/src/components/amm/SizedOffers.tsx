import SingleOffer from './singleOffer.tsx';
import type { OfferTierData } from '../../hooks/amm/useAmmData.ts';

interface SizedOffersProps {
    tiers: OfferTierData[];
    quantities: Record<string, number>;
    livePrice: bigint | null;
    floorBasis: bigint;
    disabled: boolean;
    onQtyChange: (tierKey: string, qty: number) => void;
}

export default function SizedOffers({
    tiers,
    quantities,
    livePrice,
    floorBasis,
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
                    disabled={disabled}
                    onQtyChange={(q) => onQtyChange(offer.key, q)}
                />
            ))}
        </div>
    );
}
