import { useMemo } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import stakingIdl from '../../../target/idl/staking.json';

export function useReadOnlyStakingProgram() {
    const { connection } = useConnection();
    return useMemo(() => {
        if (!connection) return null;
        const provider = new AnchorProvider(connection, {} as any, { commitment: 'confirmed' });
        return new Program(stakingIdl as any, provider);
    }, [connection]);
}
