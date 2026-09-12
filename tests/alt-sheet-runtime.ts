// Runtime hack: imports run before the validator is up — start it here
// BEFORE mocha loads the spec, then export the URL for the provider.
import { startValidator, stopValidator, rpcUrl, airdrop } from '../tests/alt-sheet-validator';
let started = false;

export async function ensureValidator(): Promise<void> {
    if (!started) {
        await startValidator();
        started = true;
    }
}

export { stopValidator, rpcUrl, airdrop };
