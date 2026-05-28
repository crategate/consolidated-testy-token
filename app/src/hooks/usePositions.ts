import { useEffect, useState, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { PublicKey, } from '@solana/web3.js';
import BN from 'bn.js';
import { useStakingProgram, STAKING_PROGRAM_ID } from '../anchor/setup';

export interface Position {
    pda: PublicKey;
    index: number;
    amount: number;
    entryTradingDay: number;
    lastClaimTimestamp: number;
}

export function usePositions(mint: PublicKey | null) {
    const { publicKey } = useWallet();
    const program = useStakingProgram();
    const [positions, setPositions] = useState<Position[]>([]);
    const [loading, setLoading] = useState(false);

    const fetchPositions = useCallback(async () => {
        if (!publicKey || !program || !mint) return;
        setLoading(true);
        try {
            const [poolPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('pool'), mint.toBuffer()],
                STAKING_PROGRAM_ID
            );
            const [userIndexPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('user_index'), publicKey.toBuffer()],
                STAKING_PROGRAM_ID
            );
            const userIndex = await (program.account as any).userStakeIndex?.fetchNullable(userIndexPda);
            const nextIndex = userIndex ? Number(userIndex.nextIndex) : 0;

            const fetched: Position[] = [];
            for (let i = 0; i < nextIndex; i++) {
                const [positionPda] = PublicKey.findProgramAddressSync([
                    Buffer.from('position'),
                    poolPda.toBuffer(),
                    publicKey.toBuffer(),
                    new BN(userIndex).toArrayLike(Buffer, 'le', 8), // possibly change userIndex to i or userIndex.nextIndex
                ], STAKING_PROGRAM_ID);
                const pos = await (program.account as any).stakePosition?.fetchNullable(positionPda);
                if (pos) {
                    fetched.push({
                        pda: positionPda,
                        index: i,
                        amount: Number(pos.amount),
                        entryTradingDay: Number(pos.entryTradingDay),
                        lastClaimTimestamp: Number(pos.lastClaimTimestamp),
                    });
                }
            }
            setPositions(fetched);
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    }, [publicKey, program, mint]);

    useEffect(() => {
        fetchPositions();
    }, [fetchPositions]);

    return { positions, loading, refresh: fetchPositions };
}
