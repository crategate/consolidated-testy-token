import { useAmmData, type DashSection } from '../../hooks/amm/useAmmData.ts';

export default function OfferLists() {
    const { data, error } = useAmmData();

    return (
        <section className="amm-page-shell">

            {error && <div className="dash-error">RPC error: {error} — showing last known state</div>}
            {!data && !error && <div className="dash-loading">Loading deployment + chain state…</div>}
            {data && (
                <main className="dash-board">
                    {data.sections.map((s) => (
                        <Section key={s.title} section={s} hideAddresses={hideAddresses} />
                    ))}
                    {data.missing.length > 0 && (
                        <footer className="dash-missing">
                            Not found on-chain: {data.missing.join(' · ')}
                        </footer>
                    )}
                </main>
            )}
        </section>
    );
}