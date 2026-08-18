import { useEffect, useState, useCallback } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { useReadOnlyStakingProgram } from '../useReadOnlyProgram';
import { STAKING_PROGRAM_ID } from '../../anchor/setup';

export interface StakePoolData {
    totalStaked: { toString(): string };
    maxMultiplierBps: number;
    posrTaxBps: number;
    accruedRewardPerShare: { toString(): string };
    [key: string]: unknown;
}

type AccountNamespace = Record<string, { fetch(key: PublicKey): Promise<unknown> } | undefined>;

export function usePool(mint: PublicKey | null) {
    const { connection } = useConnection();
    const program = useReadOnlyStakingProgram();
    const [pool, setPool] = useState<StakePoolData | null>(null);
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
            const account = (await (program.account as AccountNamespace).stakePool?.fetch(
                poolPda,
            )) as StakePoolData | null | undefined;
            setPool(account ?? null);
        } catch (e) {
            console.log('usePool: pool not found or not initialized', e instanceof Error ? e.message : e);
            setPool(null);
        } finally {
            setLoading(false);
        }
    }, [connection, mint, program]);

    useEffect(() => {
        // Deferred to a microtask so no setState runs synchronously inside the effect
        void Promise.resolve().then(fetchPool);
    }, [fetchPool]);

    return { pool, loading, refresh: fetchPool };
}