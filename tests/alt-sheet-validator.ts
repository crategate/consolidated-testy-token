// Localnet harness for the alt-sheet test: boots solana-test-validator with
// the amm + crank_oracle + staking programs, waits for health, airdrops the
// payer. Exposed as functions so the mocha suite controls the lifecycle.
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';

const SOLANA = '/home/kev/dev/sol/agave-3.1.8/bin';
const RPC = 'http://127.0.0.1:8899';
const LEDGER = '/tmp/alt-sheet-ledger';
const LOG = '/tmp/alt-sheet-validator.log';

let validator: ChildProcess | null = null;

export async function startValidator(): Promise<void> {
    if (validator) return;
    const out = fs.openSync(LOG, 'w');
    validator = spawn(
        `${SOLANA}/solana-test-validator`,
        [
            '--reset',
            '--ledger', LEDGER,
            '--bpf-program', 'AU19M8ELLh7h4GMpmj9ZKjF4NNXmYK6aiVoLs9yvnuRi', 'target/deploy/amm.so',
            '--bpf-program', 'HkA18DxZU3RSg2cJfC1vZEkkRmDnSWuXjHim2NXbao7U', 'target/deploy/crank_oracle.so',
            '--bpf-program', 'AR1Wyj3CLhcxB5jAiqFn5xHFamcjdNiiYv9gQLCVvTZp', 'target/deploy/staking.so',
            '--quiet',
        ],
        { detached: true, stdio: ['ignore', out, out] },
    );
    validator.unref();

    for (let i = 0; i < 90; i++) {
        try {
            const res = await fetch(RPC, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
            });
            const j = (await res.json()) as { result?: string };
            if (j.result === 'ok') return;
        } catch {
            // not up yet
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`test-validator did not become healthy in 90s — see ${LOG}`);
}

export async function airdrop(to: string, sol = 50): Promise<void> {
    // The faucet reports the validator healthy before it serves airdrops
    // ("Waiting for fees to stabilize"), so requests sent too early are
    // dropped. Retry the whole amount until the balance actually lands.
    const target = sol * 1_000_000_000;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
        // Airdrop in 5-SOL chunks (localnet caps per-request size)
        let remaining = sol;
        while (remaining > 0) {
            const chunk = Math.min(5, remaining);
            const res = await fetch(RPC, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'requestAirdrop',
                    params: [to, chunk * 1_000_000_000],
                }),
            });
            const j = (await res.json()) as { error?: unknown };
            if (j.error) throw new Error(`airdrop failed: ${JSON.stringify(j.error)}`);
            remaining -= chunk;
        }
        // Poll until the credit is visible (requestAirdrop returns first).
        const res = await fetch(RPC, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getBalance',
                params: [to],
            }),
        });
        const j = (await res.json()) as { result?: { value?: number } };
        if ((j.result?.value ?? 0) >= target) return;
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`airdrop of ${sol} SOL did not credit ${to} in time`);
}

export function rpcUrl(): string {
    return RPC;
}

export async function stopValidator(): Promise<void> {
    if (validator) {
        try {
            process.kill(-validator.pid!, 'SIGKILL');
        } catch {
            // already gone
        }
        validator = null;
    }
}
