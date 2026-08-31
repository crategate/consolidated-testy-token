import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { AnchorProvider, Program, type Idl, type Wallet } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import stakingIdl from '../../../target/idl/staking.json';
import {
    AMM_PROGRAM_ID,
    CRANK_PROGRAM_ID,
    decodeAmmState,
    decodeMarketStatus,
    decodeOfferList,
    deriveAmmStatePda,
    deriveMarketStatusPda,
    deriveOfferListPda,
    derivePoolPda,
    fetchDeployment,
    fetchLivePrice,
    isRateLimitError,
} from './chainDataHelpers';
import { ChainDataContext, type ChainDataContextValue, type RefreshKey } from './ChainDataContext';

/* ── Environment tuning ── */

const POLL_MS = Number(import.meta.env.VITE_RPC_POLL_MS ?? 30000);
const MARKET_STALE_MS = Number(import.meta.env.VITE_MARKET_STALE_MS ?? 30000);
const POOL_STALE_MS = Number(import.meta.env.VITE_POOL_STALE_MS ?? 60000);
const AMM_STALE_MS = Number(import.meta.env.VITE_AMM_STALE_MS ?? 30000);
const DEPLOYMENT_STALE_MS = Number(import.meta.env.VITE_DEPLOYMENT_STALE_MS ?? 60000);

/* ── Visibility hook ── */

function usePageVisible() {
    const [visible, setVisible] = useState(!document.hidden);
    useEffect(() => {
        const onVis = () => setVisible(!document.hidden);
        document.addEventListener('visibilitychange', onVis);
        return () => document.removeEventListener('visibilitychange', onVis);
    }, []);
    return visible;
}

/* ── Shared retry config ── */

function rateLimitRetry(failureCount: number, error: Error): boolean {
    if (isRateLimitError(error)) return failureCount < 2;
    return failureCount < 1;
}

function retryDelay(attemptIndex: number): number {
    // Longer, jittered delays: hammering a shared rate-limited devnet endpoint
    // makes the 429 storm worse, and the next poll tick (≤~40s) recovers anyway.
    return Math.min(4000 * 2 ** attemptIndex, 30000) + Math.random() * 2000;
}

/* ── Account-change subscription helper ──
   Opens one WebSocket listener per account. When the account changes, the
   corresponding TanStack Query cache entry is invalidated. Throttled so a
   flurry of account updates (or StrictMode double subscriptions) cannot
   trigger a retry storm against a rate-limited RPC. */

const WS_INVALIDATE_MIN_MS = 5000;

function useAccountSubscription(
    account: PublicKey | null,
    queryKey: unknown[],
    enabled: boolean,
) {
    const { connection } = useConnection();
    const queryClient = useQueryClient();
    const visible = usePageVisible();
    const lastInvalidateRef = useRef<number>(0);

    useEffect(() => {
        if (!account || !enabled || !connection) return;
        if (!visible) return;

        const id = connection.onAccountChange(
            account,
            () => {
                const now = Date.now();
                if (now - lastInvalidateRef.current < WS_INVALIDATE_MIN_MS) return;
                lastInvalidateRef.current = now;
                void queryClient.invalidateQueries({ queryKey, refetchType: 'active' });
            },
            'confirmed',
        );

        return () => {
            void connection.removeAccountChangeListener(id);
        };
    }, [connection, account, enabled, queryKey, queryClient, visible]);
}

/* ── Provider ── */

export function ChainDataProvider({ children }: { children: ReactNode }) {
    const { connection } = useConnection();
    const queryClient = useQueryClient();
    const visible = usePageVisible();

    /* Deployment — loaded once and cached. */
    const deploymentQuery = useQuery({
        queryKey: ['deployment'],
        queryFn: fetchDeployment,
        staleTime: DEPLOYMENT_STALE_MS,
        gcTime: DEPLOYMENT_STALE_MS * 2,
        refetchOnWindowFocus: false,
        retry: rateLimitRetry,
        retryDelay,
    });

    const deployment = deploymentQuery.data ?? null;

    const derived = useMemo(() => {
        if (!deployment) {
            return {
                marketStatusPda: deriveMarketStatusPda(CRANK_PROGRAM_ID),
                ammStatePda: null as PublicKey | null,
                offerListPda: null as PublicKey | null,
                poolPda: null as PublicKey | null,
            };
        }
        const ammProgram = deployment.ammProgram
            ? new PublicKey(deployment.ammProgram)
            : AMM_PROGRAM_ID;
        const crankProgram = deployment.crankProgram
            ? new PublicKey(deployment.crankProgram)
            : CRANK_PROGRAM_ID;
        return {
            marketStatusPda: deployment.marketStatusKey ?? deriveMarketStatusPda(crankProgram),
            ammStatePda: deriveAmmStatePda(deployment.mintKey, ammProgram),
            offerListPda: deriveOfferListPda(deployment.mintKey, ammProgram),
            poolPda: derivePoolPda(deployment.mintKey),
        };
    }, [deployment]);

    const { marketStatusPda, ammStatePda, offerListPda, poolPda } = derived;

    const enabled = !!connection && !!deployment && visible;

    /* Stable query keys. useAccountSubscription re-opens its WebSocket
       subscription whenever its deps change, so a fresh array literal on every
       render would unsubscribe/resubscribe all four accounts on every provider
       render (queries re-render the provider on each fetch transition). */
    const marketStatusKey = marketStatusPda.toBase58();
    const marketStatusQueryKey = useMemo(() => ['marketStatus', marketStatusKey], [marketStatusKey]);
    const poolQueryKey = useMemo(() => ['pool', poolPda?.toBase58() ?? ''], [poolPda]);
    const ammStateQueryKey = useMemo(() => ['ammState', ammStatePda?.toBase58() ?? ''], [ammStatePda]);
    const offerListQueryKey = useMemo(() => ['offerList', offerListPda?.toBase58() ?? ''], [offerListPda]);
    const livePriceQueryKey = useMemo(() => ['livePrice', ammStatePda?.toBase58() ?? ''], [ammStatePda]);

    /* Read-only staking program for typed camelCase account decoding. */
    const stakingProgram = useMemo(() => {
        if (!connection) return null;
        const provider = new AnchorProvider(connection, {} as Wallet, { commitment: 'confirmed' });
        return new Program(stakingIdl as Idl, provider);
    }, [connection]);

    /* Market status */
    const marketStatusQuery = useQuery({
        queryKey: marketStatusQueryKey,
        queryFn: async () => {
            const info = await connection.getAccountInfo(marketStatusPda, 'confirmed');
            if (!info) throw new Error('Market status PDA not found');
            const decoded = decodeMarketStatus(info.data);
            if (!decoded) throw new Error('Failed to decode market status');
            return decoded;
        },
        enabled,
        staleTime: MARKET_STALE_MS,
        // Poll ticks are staggered per query (+0s/+2s/+4s/+6s/+8s) so the
        // page never fires all its RPC requests in the same instant — aligned
        // bursts are what trip shared free-tier devnet endpoints (Helius 429s).
        refetchInterval: visible ? MARKET_STALE_MS : false,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: false,
        // Keep the last known data through a transient 429 — a single failed
        // poll tick must not blank the UI or drop the price to null.
        placeholderData: (previous) => previous,
        retry: rateLimitRetry,
        retryDelay,
    });
    useAccountSubscription(marketStatusPda, marketStatusQueryKey, enabled);

    /* Pool — use Anchor typed fetch so field names are camelCase and match
       existing consumers (usePositionRewards, usePoolStats). */
    const poolQuery = useQuery({
        queryKey: poolQueryKey,
        queryFn: async () => {
            if (!poolPda) throw new Error('Pool PDA unknown');
            if (!stakingProgram) throw new Error('Staking program not initialized');
            type AccountNamespace = Record<string, { fetch(key: PublicKey, commitment: string): Promise<unknown> } | undefined>;
            const fetcher = (stakingProgram.account as AccountNamespace).stakePool;
            if (!fetcher) throw new Error('stakePool account not on IDL');
            const pool = await fetcher.fetch(poolPda, 'confirmed');
            if (!pool) throw new Error('Stake pool not found');
            return pool as import('./chainDataHelpers').StakePoolData;
        },
        enabled: enabled && !!poolPda && !!stakingProgram,
        staleTime: POOL_STALE_MS,
        refetchInterval: visible ? POOL_STALE_MS + 4000 : false,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: false,
        placeholderData: (previous) => previous,
        retry: rateLimitRetry,
        retryDelay,
    });
    useAccountSubscription(poolPda, poolQueryKey, enabled && !!poolPda);

    /* AMM state */
    const ammStateQuery = useQuery({
        queryKey: ammStateQueryKey,
        queryFn: async () => {
            if (!ammStatePda) throw new Error('AMM state PDA unknown');
            const info = await connection.getAccountInfo(ammStatePda, 'confirmed');
            if (!info) throw new Error('AMM state not found');
            const decoded = decodeAmmState(info.data);
            if (!decoded) throw new Error('Failed to decode AMM state');
            return decoded;
        },
        enabled: enabled && !!ammStatePda,
        staleTime: AMM_STALE_MS,
        refetchInterval: visible ? AMM_STALE_MS + 2000 : false,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: false,
        placeholderData: (previous) => previous,
        retry: rateLimitRetry,
        retryDelay,
    });
    useAccountSubscription(ammStatePda, ammStateQueryKey, enabled && !!ammStatePda);

    /* Offer list */
    const offerListQuery = useQuery({
        queryKey: offerListQueryKey,
        queryFn: async () => {
            if (!offerListPda) throw new Error('Offer list PDA unknown');
            const info = await connection.getAccountInfo(offerListPda, 'confirmed');
            if (!info) return null; // Offer list may not exist yet.
            return decodeOfferList(info.data);
        },
        enabled: enabled && !!offerListPda,
        staleTime: AMM_STALE_MS,
        refetchInterval: visible ? AMM_STALE_MS + 6000 : false,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: false,
        placeholderData: (previous) => previous,
        retry: rateLimitRetry,
        retryDelay,
    });
    useAccountSubscription(offerListPda, offerListQueryKey, enabled && !!offerListPda);

    /* Live price — depends on AMM state. */
    const livePriceQuery = useQuery({
        queryKey: livePriceQueryKey,
        queryFn: async () => {
            if (!ammStatePda || !deployment?.mintKey) throw new Error('AMM state/mint unknown');
            const ammState = ammStateQuery.data;
            if (!ammState) throw new Error('AMM state not loaded');
            return fetchLivePrice(connection, ammState, deployment.mintKey);
        },
        enabled: enabled && !!ammStatePda && !!deployment?.mintKey && !!ammStateQuery.data,
        staleTime: POLL_MS,
        refetchInterval: visible ? POLL_MS + 8000 : false,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: false,
        placeholderData: (previous) => previous,
        retry: rateLimitRetry,
        retryDelay,
    });

    /* Refresh function. */
    const refresh = useCallback(
        async (key: RefreshKey) => {
            const invalidate = (qKey: unknown[]) =>
                queryClient.invalidateQueries({ queryKey: qKey, refetchType: 'active' });

            switch (key) {
                case 'deployment':
                    await invalidate(['deployment']);
                    break;
                case 'marketStatus':
                    await invalidate(['marketStatus', marketStatusPda.toBase58()]);
                    break;
                case 'pool':
                    if (poolPda) await invalidate(['pool', poolPda.toBase58()]);
                    break;
                case 'amm':
                    if (ammStatePda) await invalidate(['ammState', ammStatePda.toBase58()]);
                    if (offerListPda) await invalidate(['offerList', offerListPda.toBase58()]);
                    if (ammStatePda) await invalidate(['livePrice', ammStatePda.toBase58()]);
                    break;
                case 'livePrice':
                    if (ammStatePda) await invalidate(['livePrice', ammStatePda.toBase58()]);
                    break;
            }
        },
        [queryClient, marketStatusPda, poolPda, ammStatePda, offerListPda],
    );

    const value: ChainDataContextValue = {
        deployment,
        deploymentLoading: deploymentQuery.isLoading,
        marketStatus: marketStatusQuery.data ?? null,
        marketStatusLoading: marketStatusQuery.isLoading,
        pool: poolQuery.data ?? null,
        poolLoading: poolQuery.isLoading,
        ammState: ammStateQuery.data ?? null,
        ammStateLoading: ammStateQuery.isLoading,
        offerList: offerListQuery.data ?? null,
        offerListLoading: offerListQuery.isLoading,
        livePrice: livePriceQuery.data ?? { afhoUsdc: null, solUsdc: null },
        livePriceLoading: livePriceQuery.isLoading,
        livePriceUpdatedAt: livePriceQuery.dataUpdatedAt || null,
        refresh,
    };

    return <ChainDataContext.Provider value={value}>{children}</ChainDataContext.Provider>;
}
