
export default function OfferLists() {
    const { data, error } = useDashData();
    const [hideAddresses, setHideAddresses] = useState(false);

    return (
        <div className="amm-page-shell">
            <header className="dash-topbar">
                <h1>NYSEH dev dashboard</h1>
                <div className="dash-controls">
                    {data && <span className="dash-updated">updated {new Date(data.updatedAt).toLocaleTimeString()}</span>}
                    <button className="dash-toggle" onClick={() => setHideAddresses((v) => !v)}>
                        {hideAddresses ? 'Show addresses' : 'Hide all addresses'}
                    </button>
                </div>
            </header>
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
        </div>
    );
}
