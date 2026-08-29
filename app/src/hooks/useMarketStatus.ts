import { useCallback, useEffect, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useChainData } from '../context/useChainData';

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
const STALE_CHECK_MS = 60000;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useMarketStatus(_marketStatusPda?: string | PublicKey): UseMarketStatusReturn {
    const { marketStatus, marketStatusLoading, refresh } = useChainData();
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const id = window.setInterval(() => setNow(Date.now()), STALE_CHECK_MS);
        return () => window.clearInterval(id);
    }, []);

    const doRefresh = useCallback(() => {
        void refresh('marketStatus');
    }, [refresh]);

    const stale = marketStatus
        ? now / 1000 - marketStatus.timestamp > MAX_STALENESS_MS / 1000
        : false;

    return {
        data: marketStatus,
        loading: marketStatusLoading,
        error: marketStatusLoading ? null : marketStatus ? null : 'Market status unavailable',
        stale,
        refresh: doRefresh,
    };
}
