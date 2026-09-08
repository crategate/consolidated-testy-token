import { Link } from 'react-router-dom';
import { useAmmData } from '../../hooks/amm/useAmmData.ts';
import { quoteEffectivePrice } from '../../hooks/amm/offerMath.ts';
import FlashNumber from '../FlashNumber.tsx';
import './amm.css';

export function HomePageIndicator() {
    const { deskOpen, loading, marketState, tiers, livePrice, floorBasis } = useAmmData();

    // Only during the night window with a live, current sheet. Desk closed
    // (market open/halted) or a fully sold-out sheet → no indicator.
    if (loading || !deskOpen) return null;

    const totalLots = tiers.reduce((n, t) => n + t.remaining, 0);
    // CLOSED-session bonus (state 2): surface the late-nite discount to every
    // page — mirrors offer_claim::quote_claim's +0.5% on remaining offers.
    const closedBonus = marketState === 2 && totalLots > 0;
    // Desk dark by the buyback floor: every tier prices at/above the live
    // pool price (quote_claim would revert FloorHeldAtSpot) — say so up
    // front instead of advertising offers that can't be bought.
    const floorPaused =
        livePrice !== null && livePrice > 0n && tiers.length > 0 &&
        tiers.every((t) =>
            quoteEffectivePrice(livePrice, t.discountBps, t.bonusBps, floorBasis, marketState) >= livePrice,
        );
    const maxDiscount = tiers.reduce((m, t) => Math.max(m, t.discountBps), 0) / 10;

    return (
        <>
            <div className="home-offer-indicator-spacer" aria-hidden="true" />
            <Link
                to="/offer-desk"
                className={`home-offer-indicator${floorPaused ? ' paused' : ''}${closedBonus ? ' closed-bonus' : ''}`}
                aria-label={
                    floorPaused
                        ? 'Offer desk paused — buyback floor above spot'
                        : `Offer desk open — ${totalLots} lots remaining${closedBonus ? ' — +0.5% late nite bonus' : ''}`
                }
            >
                <span className="indicator-text">
                    <strong>{floorPaused ? 'Offer desk paused' : 'Offer desk open'}</strong>
                    <span>
                        {floorPaused
                            ? '· discounted price above spot — sales resume when it dips below live pool price'
                            : <>· after-hours AFHO bonds at up to <FlashNumber value={maxDiscount.toFixed(1)} />% off · <FlashNumber value={totalLots} /> lot{totalLots !== 1 ? 's' : ''} remaining · view offers →</>}
                    </span>
                </span>
                {closedBonus && <span className="indicator-bonus-pill">+0.5% late nite bonus</span>}
            </Link>
        </>
    );
}
