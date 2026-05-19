import { PublicKey } from '@solana/web3.js';

// Try to load from localStorage first (set after first successful connection),
// fallback to environment variable, then to a prompt
function getMint(): PublicKey {
    const saved = localStorage.getItem('nyseh_mint');
    if (saved) return new PublicKey(saved);

    const env = import.meta.env.VITE_NYSEH_MINT;
    if (env) return new PublicKey(env);

    // Default: the mint from your local deployment
    // This will fail gracefully if the pool isn't initialized yet
    throw new Error(
        'NYSEH mint not configured. Set VITE_NYSEH_MINT in .env or run mint-launch.ts first.'
    );
}

export const NYSEH_MINT = getMint();

// Crank program ID is always derived from the keypair file at build time
// For the browser, we read it from an env var or use the devnet default
export const CRANK_PROGRAM_ID = new PublicKey(
    import.meta.env.VITE_CRANK_PROGRAM_ID || 'GsUHrYWJVUeMkDAFDRq2s8hJXwmg8fYCQjJ6ApbFK1as'
);
