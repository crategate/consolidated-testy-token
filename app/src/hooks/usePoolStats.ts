import { useEffect, useState, useCallback } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { useReadOnlyStakingProgram } from './useReadOnlyProgram';

export interface PoolStats {
    totalStaked: number;
    totalSupply: number;
    userCount: number;
    decimals: number;
}

export function usePoolStats(mint: PublicKey | null) {
    const { connection } = useConnection();
    const program = useReadOnlyStakingProgram();
    const [stats, setStats] = useState<PoolStats | null>(null);
    const [loading, setLoading] = useState(false);

    const fetchStats = useCallback(async () => {
        if (!connection || !mint || !program) return;
        setLoading(true);
        try {
            const [poolPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('pool'), mint.toBuffer()],
                program.programId
            );

            const pool = await (program.account as any).stakePool?.fetchNullable(poolPda);

            const mintInfo = await connection.getParsedAccountInfo(mint);
            let supply = 0;
            let decimals = 9;
            if (mintInfo.value && 'parsed' in mintInfo.value.data) {
                const parsed = mintInfo.value.data.parsed.info;
                supply = Number(parsed.supply);
                decimals = Number(parsed.decimals);
            }

            // Rough count of UserStakeIndex accounts (discriminator 8 + u64 8 = 16 bytes)
            const userAccounts = await connection.getProgramAccounts(program.programId, {
                filters: [{ dataSize: 16 }],
                commitment: 'confirmed',
            });

            setStats({
                totalStaked: pool ? Number(pool.totalStaked) / 10 ** decimals : 0,
                totalSupply: supply / 10 ** decimals,
                userCount: userAccounts.length,
                decimals,
            });
        } catch (e) {
            console.error('Pool stats error:', e);
        } finally {
            setLoading(false);
        }
    }, [connection, mint, program]);

    useEffect(() => {
        fetchStats();
        const id = setInterval(fetchStats, 30000);
        return () => clearInterval(id);
    }, [fetchStats]);

    return { stats, loading, refresh: fetchStats };
}
