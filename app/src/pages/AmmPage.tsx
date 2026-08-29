import { useRef } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import OfferLists from '../components/amm/OfferLists.tsx';
import { useAmmData } from '../hooks/amm/useAmmData.ts';
import { useGlitchBurst } from '../hooks/useGlitchBurst.ts';
import { GlitchText } from '../components/GlitchText.tsx';
import './AmmPage.css';

const MARKET_LABELS = ['Market open', 'After-hours', 'Market closed', 'Market halted'];

export default function AmmPage() {
    const { marketState, offersLive, deskOpen, updatedAt } = useAmmData();
    const { connected } = useWallet();
    const shellRef = useRef<HTMLDivElement>(null);
    useGlitchBurst(shellRef);
    document.title = 'Bond Offer Desk | AFHO';

    // Desk excitement: open = alive & rhythmic, waiting = dim, sold out =
    // faded, everything else (desk closed / market open) = nearly dead.
    const night = marketState === 1 || marketState === 2;
    const deskState = deskOpen ? 'open' : night ? (offersLive ? 'waiting' : 'soldout') : 'dead';

    return (
        <div
            ref={shellRef}
            className="amm-page-shell"
            data-connected={connected}
            data-market-state={marketState ?? 99}
            data-desk={deskState}
        >
            <header className="amm-topbar">
                <div className="amm-title">
                    <h1><GlitchText text="Bond Offer Desk" variant="bluepink" step={0.07} /></h1>
                    <span className={`market-badge ${deskOpen ? 'open' : ''}`}>
                        {marketState !== null ? MARKET_LABELS[marketState] ?? 'Unknown' : 'Market status unknown'}
                        {deskOpen ? ' · desk open' : ''}
                        {!deskOpen && marketState !== null && !offersLive ? ' · no live offers' : ''}
                    </span>
                </div>
                <div className="amm-controls">
                    {updatedAt && (
                        <span className="amm-updated">updated {new Date(updatedAt).toLocaleTimeString()}</span>
                    )}
                    <div className="wallet-button-wrapper">
                        <WalletMultiButton />
                    </div>
                </div>
            </header>

            <OfferLists />
        </div>
    );
}
