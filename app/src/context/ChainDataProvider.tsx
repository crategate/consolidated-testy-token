import {
    useCallback,
    useEffect,
    useMemo,
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

const POLL_MS = Number(import.meta.env.VITE_RPC_POLL_MS ?? 15000);
const MARKET_STALE_MS = Number(import.meta.env.VITE_MARKET_STALE_MS ?? 15000);
const POOL_STALE_MS = Number(import.meta.env.VITE_POOL_STALE_MS ?? 60000);
const AMM_STALE_MS = Number(import.meta.env.VITE_AMM_STALE_MS ?? 15000);
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
    if (isRateLimitError(error)) return failureCount < 3;
    return failureCount < 1;
}

function retryDelay(attemptIndex: number): number {
    return Math.min(1000 * 2 ** attemptIndex, 30000);
}

/* ── Account-change subscription helper ──
   Opens one WebSocket listener per account. When the account changes, the
   corresponding TanStack Query cache entry is invalidated. Because the query
   itself has staleTime, this usually results in a single re-fetch per change,
   not a retry storm. */

function useAccountSubscription(
    account: PublicKey | null,
    queryKey: unknown[],
    enabled: boolean,
) {
    const { connection } = useConnection();
    const queryClient = useQueryClient();
    const visible = usePageVisible();

    useEffect(() => {
        if (!account || !enabled || !connection) return;
        if (!visible) return;

        const id = connection.onAccountChange(
            account,
            () => {
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

    /* Read-only staking program for typed camelCase account decoding. */
    const stakingProgram = useMemo(() => {
        if (!connection) return null;
        const provider = new AnchorProvider(connection, {} as Wallet, { commitment: 'confirmed' });
        return new Program(stakingIdl as Idl, provider);
    }, [connection]);

    /* Market status */
    const marketStatusQuery = useQuery({
        queryKey: ['marketStatus', marketStatusPda.toBase58()],
        queryFn: async () => {
            const info = await connection.getAccountInfo(marketStatusPda, 'confirmed');
            if (!info) throw new Error('Market status PDA not found');
            const decoded = decodeMarketStatus(info.data);
            if (!decoded) throw new Error('Failed to decode market status');
            return decoded;
        },
        enabled,
        staleTime: MARKET_STALE_MS,
        refetchInterval: visible ? MARKET_STALE_MS : false,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: false,
        retry: rateLimitRetry,
        retryDelay,
    });
    useAccountSubscription(marketStatusPda, ['marketStatus', marketStatusPda.toBase58()], enabled);

    /* Pool — use Anchor typed fetch so field names are camelCase and match
       existing consumers (usePositionRewards, usePoolStats). */
    const poolQuery = useQuery({
        queryKey: ['pool', poolPda?.toBase58() ?? ''],
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
        refetchInterval: visible ? POOL_STALE_MS : false,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: false,
        retry: rateLimitRetry,
        retryDelay,
    });
    useAccountSubscription(poolPda, ['pool', poolPda?.toBase58() ?? ''], enabled && !!poolPda);

    /* AMM state */
    const ammStateQuery = useQuery({
        queryKey: ['ammState', ammStatePda?.toBase58() ?? ''],
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
        refetchInterval: visible ? AMM_STALE_MS : false,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: false,
        retry: rateLimitRetry,
        retryDelay,
    });
    useAccountSubscription(ammStatePda, ['ammState', ammStatePda?.toBase58() ?? ''], enabled && !!ammStatePda);

    /* Offer list */
    const offerListQuery = useQuery({
        queryKey: ['offerList', offerListPda?.toBase58() ?? ''],
        queryFn: async () => {
            if (!offerListPda) throw new Error('Offer list PDA unknown');
            const info = await connection.getAccountInfo(offerListPda, 'confirmed');
            if (!info) return null; // Offer list may not exist yet.
            return decodeOfferList(info.data);
        },
        enabled: enabled && !!offerListPda,
        staleTime: AMM_STALE_MS,
        refetchInterval: visible ? AMM_STALE_MS : false,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: false,
        retry: rateLimitRetry,
        retryDelay,
    });
    useAccountSubscription(offerListPda, ['offerList', offerListPda?.toBase58() ?? ''], enabled && !!offerListPda);

    /* Live price — depends on AMM state. */
    const livePriceQuery = useQuery({
        queryKey: ['livePrice', ammStatePda?.toBase58() ?? ''],
        queryFn: async () => {
            if (!ammStatePda || !deployment?.mintKey) throw new Error('AMM state/mint unknown');
            const ammState = ammStateQuery.data;
            if (!ammState) throw new Error('AMM state not loaded');
            return fetchLivePrice(connection, ammState, deployment.mintKey);
        },
        enabled: enabled && !!ammStatePda && !!deployment?.mintKey && !!ammStateQuery.data,
        staleTime: POLL_MS,
        refetchInterval: visible ? POLL_MS : false,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: false,
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
        refresh,
    };

    return <ChainDataContext.Provider value={value}>{children}</ChainDataContext.Provider>;
}
