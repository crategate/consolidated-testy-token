import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import OfferLists from '../components/amm/OfferLists.tsx';
import { useAmmData } from '../hooks/amm/useAmmData.ts';
import './AmmPage.css';

const MARKET_LABELS = ['Market open', 'After-hours', 'Market closed', 'Market halted'];

export default function AmmPage() {
    const { marketState, offersLive, deskOpen, updatedAt } = useAmmData();
    document.title = 'Bond Offer Desk | AFHO';

    return (
        <div className="amm-page-shell">
            <header className="amm-topbar">
                <div className="amm-title">
                    <h1>Bond Offer Desk</h1>
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
                    <WalletMultiButton />
                </div>
            </header>

            <OfferLists />
        </div>
    );
}
