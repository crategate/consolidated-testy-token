import { GlitchText } from '../GlitchText';

const LOGOS = [
    { name: 'Raydium', src: '/raydium-logo-and-letters.svg', top: '16px', link: 'https://docs.raydium.io/' },
    { name: 'Solana', src: '/solana-logo-and-letters.png', link: 'https://www.anchor-lang.com/docs' },
    { name: 'Switchboard', src: '/switchboard-logo-and-letters.svg', top: '16px', link: 'https://docs.switchboard.xyz/' },
];

export function BuiltWithSection() {
    return (
        <section className="landing-section">
            <div className="landing-section-inner">
                <h2 className="section-title"><GlitchText text="Built With" variant="ghost" /></h2>
                <div className="built-with-grid">
                    {LOGOS.map((logo, index) => (
                        <a href={logo.link}>
                            <div
                                key={logo.name}
                                className={`built-with-tile neon-glitch neon-shadow glass-pane ${['glitch-streetlight', 'glitch-shift', 'glitch-rose'][index]} ${['shadow-under', 'shadow-corner-tl', 'shadow-corner-br'][index]}`}
                                style={{
                                    '--glitch-delay': `${(index * 0.9).toFixed(2)}s`,
                                    '--shadow-delay': `${(index * 1.1 + 0.2).toFixed(2)}s`,
                                } as React.CSSProperties}
                            >
                                <img
                                    src={logo.src}
                                    alt={`${logo.name} logo`}
                                    className="built-with-logo"
                                    style={{ marginTop: logo.top }}
                                    loading="lazy"
                                />
                            </div>
                        </a>
                    ))}
                </div>
            </div>
        </section>
    );
}
