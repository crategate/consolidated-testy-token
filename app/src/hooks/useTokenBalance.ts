import { useCallback, useEffect, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import {
    getAssociatedTokenAddressSync,
    TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';

// SPL / Token-2022 token account `amount` is a u64 LE at offset 64.
function amountFromAccountInfo(info: { data: Uint8Array }): number {
    const view = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
    return Number(view.getBigUint64(64, true));
}

/**
 * Live wallet token balance, driven by an `onAccountChange` subscription on
 * the associated token account (push, no polling). Fetches once on mount and
 * then updates as soon as the account changes on-chain.
 */
export function useTokenBalance(
    mint: PublicKey | null,
    owner: PublicKey | null,
    decimals = 9,
): { balance: number | null; refresh: () => Promise<void> } {
    const { connection } = useConnection();
    const [balance, setBalance] = useState<number | null>(null);

    const refresh = useCallback(async () => {
        if (!connection || !mint || !owner) {
            setBalance(null);
            return;
        }
        try {
            const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
            const info = await connection.getAccountInfo(ata, 'confirmed');
            setBalance(info ? amountFromAccountInfo(info) / 10 ** decimals : 0);
        } catch {
            setBalance(0);
        }
    }, [connection, mint, owner, decimals]);

    useEffect(() => {
        if (!connection || !mint || !owner) {
            void Promise.resolve().then(() => setBalance(null));
            return;
        }

        const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
        let cancelled = false;

        void Promise.resolve().then(async () => {
            try {
                const info = await connection.getAccountInfo(ata, 'confirmed');
                if (!cancelled) {
                    setBalance(info ? amountFromAccountInfo(info) / 10 ** decimals : 0);
                }
            } catch {
                if (!cancelled) setBalance(0);
            }
        });

        const subscriptionId = connection.onAccountChange(
            ata,
            (info) => {
                if (!cancelled) {
                    setBalance(amountFromAccountInfo(info) / 10 ** decimals);
                }
            },
            'confirmed',
        );

        return () => {
            cancelled = true;
            void connection.removeAccountChangeListener(subscriptionId);
        };
    }, [connection, mint, owner, decimals]);

    return { balance, refresh };
}
