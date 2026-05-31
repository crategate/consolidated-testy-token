import { useEffect, useState, useCallback } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { useReadOnlyStakingProgram } from './useReadOnlyProgram';
import { STAKING_PROGRAM_ID } from '../anchor/setup';

export function usePool(mint: PublicKey | null) {
    const { connection } = useConnection();
    const program = useReadOnlyStakingProgram();
    const [pool, setPool] = useState<any>(null);
    const [loading, setLoading] = useState(false);

    const fetchPool = useCallback(async () => {
        if (!connection || !mint || !program) {
            setPool(null);
            return;
        }
        setLoading(true);
        try {
            const [poolPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('pool'), mint.toBuffer()],
                STAKING_PROGRAM_ID
            );
            const account = await (program.account as any).stakePool.fetch(poolPda);
            setPool(account);
        } catch (e: any) {
            console.log('usePool: pool not found or not initialized', e.message);
            setPool(null);
        } finally {
            setLoading(false);
        }
    }, [connection, mint, program]);

    useEffect(() => {
        fetchPool();
    }, [fetchPool]);

    return { pool, loading, refresh: fetchPool };
}
