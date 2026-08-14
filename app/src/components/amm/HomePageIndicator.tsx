import { Link } from 'react-router-dom';
import { useAmmData } from '../../hooks/amm/useAmmData.ts';
import './amm.css';

export function HomePageIndicator() {
    const { offersLive, loading, offerList } = useAmmData();

    if (loading || !offersLive) return null;

    // Sum remaining lots across tiers (handles both camelCase & snake_case IDL)
    const getTier = (key: string) => (offerList?.[key] as Record<string, number> | undefined);
    const big = getTier('bigOffer') || getTier('big_offer');
    const med = getTier('medOffer') || getTier('med_offer');
    const sml = getTier('smlOffer') || getTier('sml_offer');

    const totalLots = (big?.remaining || 0) + (med?.remaining || 0) + (sml?.remaining || 0);

    return (
        <Link to="/amm" className="home-offer-indicator" aria-label="Active offers available">
            <span className="indicator-pulse" aria-hidden="true" />
            <div className="indicator-text">
                <strong>Offers Are Live</strong>
                <span>
                    {totalLots > 0
                        ? `${totalLots} lot${totalLots !== 1 ? 's' : ''} remaining · Bond Offer Desk →`
                        : 'Bulk deals available now · Bond Offer Desk →'}
                </span>
            </div>
        </Link>
    );
}
