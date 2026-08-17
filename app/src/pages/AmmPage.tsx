import { useState } from 'react';
import { useAmmData } from '../hooks/amm/useAmmData.ts';
import OfferLists from '../components/amm/OfferLists.tsx';
import './Dash.css';

function StatusDot({ on }: { on: boolean }) {
    return <span className={`dash-dot ${on ? 'on' : 'off'}`} title={on ? 'initialized' : 'not initialized'} />;
}

function Section({ section, hideAddresses }: { section: DashSection; hideAddresses: boolean }) {
    return (
        <section className={`dash-section ${section.initialized ? 'active' : ''}`}>
            <header className="dash-section-header">
                <StatusDot on={section.initialized} />
                <h2>{section.title}</h2>
                <span className="dash-state-label">{section.initialized ? 'active' : 'not initialized'}</span>
            </header>
            <div className="dash-grid">
                {section.fields.map((f) => (
                    <div className="dash-row" key={f.label}>
                        <span className="dash-label">{f.label}</span>
                        <span className="dash-value">{f.value}</span>
                    </div>
                ))}
                {!hideAddresses &&
                    section.addresses.map((a) => (
                        <div className="dash-row dash-addr" key={a.label}>
                            <span className="dash-label">{a.label}</span>
                            <span className="dash-value mono">{a.value}</span>
                        </div>
                    ))}
            </div>
        </section>
    );
}

export default function AmmPage() {
    const data = useAmmData();
    const [hideAddresses, setHideAddresses] = useState(false);
    const [offersLive, setoffersLive] = useState(false);
    document.title = "Bond Offer Desk | NYSEH"



    return (
        <div className="amm-page-shell">
            <header className="dash-topbar">
                <h1 className="offers-live">{offersLive ? "Offers Are Live!" : "No Offers Available, Check Back End of Next Trading Day"}</h1>
                <div className="dash-controls">
                    {data && <span className="dash-updated">updated {new Date(data.updatedAt).toLocaleTimeString()}</span>}
                    <button className="dash-toggle" onClick={() => setHideAddresses((v) => !v)}>
                        {hideAddresses ? 'Show addresses' : 'Hide all addresses'}
                    </button>
                </div>
            </header>
            {<div className="dash-error">RPC error: {} — showing last known state</div>}
            {!data && <div className="dash-loading">Loading deployment + chain state…</div>}
            {data && (
                <main className="dash-board">

                    {console.log(data)}
                </main>
            )}
        </div>
    );
}
