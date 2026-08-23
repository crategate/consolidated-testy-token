import { Link } from 'react-router-dom';
import { useAmmData } from '../../hooks/amm/useAmmData.ts';
import './amm.css';

export function HomePageIndicator() {
    const { offersLive, loading, tiers } = useAmmData();

    if (loading || !offersLive) return null;

    const totalLots = tiers.reduce((n, t) => n + t.remaining, 0);

    return (
        <Link to="/offer-desk" className="home-offer-indicator" aria-label="Active offers available">
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
