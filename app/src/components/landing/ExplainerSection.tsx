const EXPLAINERS = [
    {
        icon: '🌙',
        title: 'NYSE Hours',
        body: 'When the market is open, after-hours, closed, and halted decides rewards, penalties, and the bond sales.',
    },
    {
        icon: '⚡',
        title: 'Stake & Multiply',
        body: 'Lock AFHO to earn your cut of 10% from bond sales, and impatient weekend panickers. Exit after hours and penalties apply.',
    },
    {
        icon: '📉',
        title: 'Buy the Dip',
        body: '10% of bond proceeds fuel an always active dip sniper, refilling the offer desk and buffering market turbulence',
    },
    {
        icon: '🏦',
        title: 'Bond Offer Desk',
        body: 'After closing bell, the offer desk sells vested AFHO bonds. This bond vault starts as 75% of total minted tokens.',
    },
];

const SPLIT = [
    { label: 'Buybacks', value: 80, color: 'var(--neon-cyan)' },
    { label: 'Dip Reserve', value: 10, color: 'var(--neon-pink)' },
    { label: 'to Stakers', value: 10, color: 'var(--neon-purple)' },
];

export function ExplainerSection() {
    return (
        <section className="landing-section alt">
            <div className="landing-section-inner">
                <h2 className="section-title">Features & Mechanics</h2>
                <p className="section-subtitle">
                    AFHO ties token incentives to the tradFi market pulse.</p>
                <p className="section-subtitle">
                    staking, buybacks, and bond sales change with Wall St's market status
                </p>
                <div className="explainer-grid">
                    {EXPLAINERS.map((item, index) => (
                        <div
                            key={item.title}
                            className="explainer-card neon-glitch"
                            style={{ '--glitch-delay': `${(index * 0.7).toFixed(2)}s` } as React.CSSProperties}
                        >
                            <div className="explainer-icon">{item.icon}</div>
                            <h4>{item.title}</h4>
                            <p>{item.body}</p>
                        </div>
                    ))}
                </div>

                <div
                    className="split-chart neon-glitch"
                    style={{ '--glitch-delay': '1.4s' } as React.CSSProperties}
                >
                    <h4 className="split-title">Bond Offer Proceeds:</h4>
                    <div className="split-bars">
                        {SPLIT.map((s) => (
                            <div key={s.label} className="split-bar-wrap">
                                <div className="split-bar-track">
                                    <div
                                        className="split-bar-fill"
                                        style={{ height: `${s.value}%`, background: s.color }}
                                    />
                                </div>
                                <span className="split-value">{s.value}%</span>
                                <span className="split-label">{s.label}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </section >
    );
}
