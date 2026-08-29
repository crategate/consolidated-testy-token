import type { CSSProperties } from 'react';

interface GlitchTextProps {
    text: string;
    variant?: 'default' | 'bluepink' | 'streetlight' | 'ghost';
    className?: string;
    /** seconds of stagger per letter; the connected state tightens this via CSS */
    step?: number;
}

/**
 * Splits a text body into per-letter spans so each character runs its own
 * glitch animation with a slight cascade. Disconnected: a loose, out-of-sync
 * cascade. Connected: the CSS tightens the stagger and speeds the cycle so
 * the whole word lands on one regular rhythm.
 */
export function GlitchText({ text, variant = 'default', className = '', step = 0.06 }: GlitchTextProps) {
    return (
        <span
            className={`glitch-letters glitch-letters--${variant} ${className}`.trim()}
            aria-label={text}
        >
            {text.split('').map((ch, i) => (
                <span
                    key={i}
                    aria-hidden="true"
                    style={{ '--i': i, '--letter-stagger': `${step}s` } as CSSProperties}
                >
                    {ch === ' ' ? '\u00A0' : ch}
                </span>
            ))}
        </span>
    );
}
