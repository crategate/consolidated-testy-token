import { useEffect, useState, useCallback } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { CRANK_PROGRAM_ID } from '../anchor/setup';

interface MarketStatusData {
    state: number;
    timestamp: number;
    tradingDay: number;
}

interface UseMarketStatusReturn {
    data: MarketStatusData | null;
    loading: boolean;
    error: string | null;
    stale: boolean;
    refresh: () => void;
}

const MAX_STALENESS_MS = 5 * 60 * 1000;

export function useMarketStatus(marketStatusPda?: PublicKey): UseMarketStatusReturn {
    const { connection } = useConnection();
    const [data, setData] = useState<MarketStatusData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchStatus = useCallback(async () => {
        if (!connection) return;
        try {
            const fallbackPda = PublicKey.findProgramAddressSync(
                [new TextEncoder().encode('market_status')],
                CRANK_PROGRAM_ID
            )[0];
            const accountInfo = await connection.getAccountInfo(marketStatusPda ?? fallbackPda);
            if (!accountInfo) {
                throw new Error('Market status PDA not found. Has the crank oracle been initialized?');
            }

            const buf = accountInfo.data;
            if (buf.length < 25) {
                throw new Error(`Market status account too small: ${buf.length} bytes (expected ≥25)`);
            }

            // DataView correctly handles Buffer views AND Uint8Array copies
            const view = new DataView(buf.buffer, buf.byteOffset);
            const state = view.getUint8(8);
            const timestamp = Number(view.getBigInt64(9, true));   // little-endian
            const tradingDay = Number(view.getBigUint64(17, true)); // little-endian

            setData({ state, timestamp, tradingDay });
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error fetching oracle');
        } finally {
            setLoading(false);
        }
    }, [connection, marketStatusPda]);

    useEffect(() => {
        fetchStatus();
        const interval = setInterval(fetchStatus, 30000);
        return () => clearInterval(interval);
    }, [fetchStatus]);

    const stale = data
        ? (Date.now() / 1000) - data.timestamp > (MAX_STALENESS_MS / 1000)
        : false;

    return { data, loading, error, stale, refresh: fetchStatus };
}
