import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import './SiteNav.css';

/* Site nav — sits over the hero (and every page that includes it).
 * Full bar on wide screens; collapsible hamburger below the breakpoint.
 * Items: Records ledger, Litepaper, social links (Twitter / Telegram). */

// TODO(mainnet): point these at the real accounts before launch.
export const SOCIAL_LINKS = {
    twitter: 'https://x.com/',
    telegram: 'https://t.me/',
};

type NavItem = {
    label: string;
    to: string;
};

const NAV_ITEMS: NavItem[] = [
    { label: 'Records', to: '/records' },
    { label: 'Litepaper', to: '/litepaper' },
];

function TwitterIcon() {
    return (
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
            <path
                fill="currentColor"
                d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
            />
        </svg>
    );
}

function TelegramIcon() {
    return (
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
            <path
                fill="currentColor"
                d="M21.944 3.112 2.72 10.558c-1.31.525-1.302 1.253-.24 1.578l4.928 1.537 1.862 5.704c.226.623.117.87.797.87.522 0 .754-.238 1.047-.524l2.514-2.444 5.228 3.862c.963.531 1.657.257 1.897-.894l3.44-16.223c.351-1.408-.538-2.045-1.459-1.63zM8.04 13.4l9.882-6.238c.513-.312.983-.144.598.198l-8.467 7.64-.331 3.538z"
            />
        </svg>
    );
}

interface SiteNavProps {
    /* Rendered in place of the brand text when provided (e.g. non-home
     * pages show a word-mark that links back). */
    brand?: ReactNode;
}

export function SiteNav({ brand }: SiteNavProps) {
    const [open, setOpen] = useState(false);
    const { pathname } = useLocation();

    // Close the drawer whenever the route changes.
    useEffect(() => {
        setOpen(false);
    }, [pathname]);

    const isActive = useMemo(
        () => (to: string) => pathname === to || pathname.startsWith(`${to}/`),
        [pathname],
    );

    return (
        <nav className={`site-nav${open ? ' open' : ''}`} aria-label="Site">
            <div className="site-nav-bar">
                <Link to="/" className="site-nav-brand neon-glitch" style={{ '--glitch-delay': '1.1s' } as React.CSSProperties}>
                    {brand ?? 'AFHO'}
                </Link>

                <div className="site-nav-links" id="site-nav-links">
                    {NAV_ITEMS.map((item) => (
                        <Link
                            key={item.to}
                            to={item.to}
                            className={`site-nav-link${isActive(item.to) ? ' active' : ''}`}
                            aria-current={isActive(item.to) ? 'page' : undefined}
                        >
                            {item.label}
                        </Link>
                    ))}
                    <a
                        className="site-nav-icon"
                        href={SOCIAL_LINKS.twitter}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label="AFHO on X (Twitter)"
                    >
                        <TwitterIcon />
                    </a>
                    <a
                        className="site-nav-icon"
                        href={SOCIAL_LINKS.telegram}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label="AFHO on Telegram"
                    >
                        <TelegramIcon />
                    </a>
                </div>

                <button
                    type="button"
                    className="site-nav-toggle"
                    aria-expanded={open}
                    aria-controls="site-nav-links"
                    onClick={() => setOpen((v) => !v)}
                >
                    <span className="site-nav-toggle-box" aria-hidden="true">
                        <span className="site-nav-toggle-line" />
                        <span className="site-nav-toggle-line" />
                        <span className="site-nav-toggle-line" />
                    </span>
                    <span className="site-nav-toggle-label">Menu</span>
                </button>
            </div>
        </nav>
    );
}
