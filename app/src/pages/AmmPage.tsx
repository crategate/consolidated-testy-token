import { useState } from 'react';
import { useAmmData, type AmmSection } from '../hooks/amm/useAmmData.ts';
import OfferLists from '../components/amm/OfferLists.tsx';
import './Dash.css';

function StatusDot({ on }: { on: boolean }) {
    return <span className={`dash-dot ${on ? 'on' : 'off'}`} title={on ? 'initialized' : 'not initialized'} />;
}

function Section({ section, hideOfferSection }: { section: AmmSection; hideOfferSection: boolean }) {
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
                {hideOfferSection && <h2>No Offers Available</h2>
                }
            </div>
        </section>
    );
}

export default function AmmPage() {
    const ammData = useAmmData();
    const [hideOfferSection, setHideOfferSection] = useState(true);
    const [offersLive, setoffersLive] = useState(true);
    document.title = "Bond Offer Desk | NYSEH"



    return (
        <div className="amm-page-shell">
            <header className="dash-topbar">
                <h1 className="offers-live">{offersLive ? "Offers Are Live!" : "No Offers Available, Check Back End of Next Trading Day"}</h1>
                <div className="dash-controls">
                    {ammData && <span className="dash-updated">updated {new Date(ammData.updatedAt).toLocaleTimeString()}</span>}
                    <button className="dash-toggle" onClick={() => setHideOfferSection((v) => !v)}>
                        {hideOfferSection ? 'Show addresses' : 'Hide all addresses'}
                    </button>
                </div>
            </header>
            {ammData && (
                <main className="dash-board">
                    {ammData.sections.map((s) => (
                        <Section key={s.title} section={s} hideOfferSection={hideOfferSection} />
                    ))}
                    {ammData.missing.length > 0 && (
                        <footer className="dash-missing">
                            Not found on-chain: {ammData.missing.join(' · ')}
                        </footer>
                    )}
                </main>
            )}
        </div>
    );
}
