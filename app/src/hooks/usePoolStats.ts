import { useEffect, useState, useCallback } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey, type ParsedAccountData } from '@solana/web3.js';
import { useReadOnlyStakingProgram } from './useReadOnlyProgram';
import { STAKING_PROGRAM_ID } from '../anchor/setup';
import type { StakePoolData } from './stake/usePool';
export interface PoolStats {
    totalStaked: number;
    totalSupply: number;
    userCount: number;
    decimals: number;
}

type AccountNamespace = Record<string, { fetch(key: PublicKey): Promise<unknown> } | undefined>;

export function usePoolStats(mint: PublicKey | null) {
    const { connection } = useConnection();
    const program = useReadOnlyStakingProgram();
    const [stats, setStats] = useState<PoolStats | null>(null);
    const [loading, setLoading] = useState(false);

    const fetchStats = useCallback(async () => {
        if (!connection || !mint || !program) {
            console.log('PoolStats: missing deps', { connection: !!connection, mint: !!mint, program: !!program });
            return;
        }
        setLoading(true);
        try {
            const [poolPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('pool'), mint.toBuffer()],
                STAKING_PROGRAM_ID
            );
            console.log('PoolStats: fetching pool at', poolPda.toBase58());

            // Try to fetch pool account - use try/catch since fetchNullable doesn't exist
            let pool: StakePoolData | null = null;
            try {
                pool = (await (program.account as AccountNamespace).stakePool?.fetch(
                    poolPda,
                )) as StakePoolData | null;
                console.log('PoolStats: pool fetched', pool);
            } catch (e) {
                console.log('PoolStats: pool not found or not initialized yet', e instanceof Error ? e.message : e);
            }

            // Get mint info for supply and decimals
            const mintInfo = await connection.getParsedAccountInfo(mint);
            let supply = 0;
            let decimals = 9;
            if (mintInfo.value && 'parsed' in mintInfo.value.data) {
                const parsed = (mintInfo.value.data as ParsedAccountData).parsed.info;
                supply = Number(parsed.supply);
                decimals = Number(parsed.decimals);
                console.log('PoolStats: mint info', { supply, decimals });
            } else {
                console.log('PoolStats: could not parse mint info');
            }

            // Count user index accounts - UserStakeIndex is 8 (discriminator) + 8 (next_index u64) = 16 bytes
            // But let's also check for position accounts which are larger
            let userCount = 0;
            try {
                const userAccounts = await connection.getProgramAccounts(program.programId, {
                    filters: [
                        { dataSize: 16 }, // UserStakeIndex accounts
                    ],
                    commitment: 'confirmed',
                });
                userCount = userAccounts.length;
                console.log('PoolStats: found users', userCount);
            } catch (e) {
                console.log('PoolStats: error counting users', e);
            }

            const totalStaked = pool ? Number(pool.totalStaked) / 10 ** decimals : 0;

            setStats({
                totalStaked,
                totalSupply: supply / 10 ** decimals,
                userCount,
                decimals,
            });
        } catch (e) {
            console.error('PoolStats error:', e);
        } finally {
            setLoading(false);
        }
    }, [connection, mint, program]);

    useEffect(() => {
        // Deferred to a microtask so no setState runs synchronously inside the effect
        void Promise.resolve().then(fetchStats);
    }, [fetchStats]);

    return { stats, loading, refresh: fetchStats };
}