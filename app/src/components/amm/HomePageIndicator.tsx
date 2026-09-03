import { Link } from 'react-router-dom';
import { useAmmData } from '../../hooks/amm/useAmmData.ts';
import './amm.css';

export function HomePageIndicator() {
    const { deskOpen, loading, marketState, tiers } = useAmmData();

    // Only during the night window with a live, current sheet. Desk closed
    // (market open/halted) or a fully sold-out sheet → no indicator.
    if (loading || !deskOpen) return null;

    const totalLots = tiers.reduce((n, t) => n + t.remaining, 0);
    // CLOSED-session bonus (state 2): surface the late-nite discount to every
    // page — mirrors offer_claim::quote_claim's +0.5% on remaining offers.
    const closedBonus = marketState === 2 && totalLots > 0;

    return (
        <>
            <div className="home-offer-indicator-spacer" aria-hidden="true" />
            <Link
                to="/offer-desk"
                className={`home-offer-indicator${closedBonus ? ' closed-bonus' : ''}`}
                aria-label={`Offers available now — ${totalLots} lots remaining${closedBonus ? ' — +0.5% late nite bonus' : ''}`}
            >
                <span className="indicator-pulse" aria-hidden="true" />
                <span className="indicator-text">
                    <strong>Offers available now</strong>
                    <span>
                        · {totalLots} lot{totalLots !== 1 ? 's' : ''} remaining · View offers →
                    </span>
                </span>
                {closedBonus && <span className="indicator-bonus-pill">+0.5% late nite bonus</span>}
            </Link>
        </>
    );
}
