import SingleOffer from './singleOffer.tsx';
import type { OfferTierData } from '../../hooks/amm/useAmmData.ts';

interface SizedOffersProps {
    tiers: OfferTierData[];
    quantities: Record<string, number>;
    livePrice: bigint | null;
    floorBasis: bigint;
    nysehDecimals: number;
    usdcDecimals: number;
    disabled: boolean;
    onQtyChange: (tierKey: string, qty: number) => void;
}

export default function SizedOffers({
    tiers,
    quantities,
    livePrice,
    floorBasis,
    nysehDecimals,
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
                    nysehDecimals={nysehDecimals}
                    usdcDecimals={usdcDecimals}
                    disabled={disabled}
                    onQtyChange={(q) => onQtyChange(offer.key, q)}
                />
            ))}
        </div>
    );
}
