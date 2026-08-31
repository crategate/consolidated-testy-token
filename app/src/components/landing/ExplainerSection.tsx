import { GlitchText } from '../GlitchText';
import { SplitDonut } from './SplitDonut';

const EXPLAINERS = [
    {
        icon: 'N',
        title: 'NYSE Hours',
        body: 'When the market is open, after-hours, closed, and halted decides rewards, penalties, and the bond sales.',
    },
    {
        icon: 'x',
        title: 'Stake & Multiply',
        body: 'Lock AFHO to earn your cut of 10% from bond sales, and impatient weekend panickers. Exit after hours and penalties apply.',
    },
    {
        icon: 'v',
        title: 'Buy the Dip',
        body: '10% of bond proceeds fuel an always active dip sniper, refilling the offer desk and buffering market turbulence',
    },
    {
        icon: '$',
        title: 'Bond Offer Desk',
        body: 'After closing bell, the offer desk sells vested AFHO bonds. This bond vault starts as 75% of total minted tokens.',
    },
];

export function ExplainerSection() {
    return (
        <section className="landing-section alt">
            <div className="landing-section-inner">
                <h2 className="section-title"><GlitchText text="Features & Mechanics" /></h2>
                <p className="section-subtitle">
                    <GlitchText text="AFHO ties token incentives to the tradFi market pulse." variant="light" split="word" step={0.35} />
                </p>
                <p className="section-subtitle" style={{} as React.CSSProperties}>
                    <GlitchText text="staking, buybacks, and bond sales change with Wall St's market status" variant="light" split="word" step={0.4} />
                </p>
                <div className="explainer-grid">
                    {EXPLAINERS.map((item, index) => (
                        <div
                            key={item.title}
                            className={`explainer-card neon-glitch neon-shadow glass-pane ${['glitch-violet', 'glitch-streetlight', 'glitch-ghost', 'glitch-rose'][index]} ${['shadow-corner-tl', 'shadow-corner-br', 'shadow-corner-bl', 'shadow-corner-tr'][index]}`}
                            style={{
                                '--glitch-delay': `${(index * 0.7).toFixed(2)}s`,
                                '--shadow-delay': `${(index * 0.9 + 0.4).toFixed(2)}s`,
                            } as React.CSSProperties}
                        >
                            <div className="explainer-icon">{item.icon}</div>
                            <h4>{item.title}</h4>
                            <p>{item.body}</p>
                        </div>
                    ))}
                </div>

                <div
                    className="split-chart neon-glitch neon-shadow shadow-corner-bl glass-pane"
                    style={{ '--glitch-delay': '1.4s', '--shadow-delay': '2s' } as React.CSSProperties}
                >
                    <h4 className="split-title">Bond Offer Proceeds:</h4>
                    <SplitDonut />
                </div>
            </div>
        </section >
    );
}
