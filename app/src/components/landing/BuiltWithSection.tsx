const LOGOS = [
    { name: 'Raydium', src: '/raydium-logo-and-letters.svg' },
    { name: 'Solana', src: '/solana-logo-and-letters.png' },
    { name: 'Switchboard', src: '/switchboard-logo-and-letters.svg' },
];

export function BuiltWithSection() {
    return (
        <section className="landing-section">
            <div className="landing-section-inner">
                <h2 className="section-title">Built With</h2>
                <div className="built-with-grid">
                    {LOGOS.map((logo, index) => (
                        <div
                            key={logo.name}
                            className="built-with-tile neon-glitch"
                            style={{ '--glitch-delay': `${(index * 0.9).toFixed(2)}s` } as React.CSSProperties}
                        >
                            <img
                                src={logo.src}
                                alt={`${logo.name} logo`}
                                className="built-with-logo"
                                loading="lazy"
                            />
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}
