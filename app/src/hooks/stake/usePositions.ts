import { useEffect, useState, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { useStakingProgram, STAKING_PROGRAM_ID } from '../../anchor/setup';

export interface Position {
    pda: PublicKey;
    index: number;
    amount: number;
    entryTradingDay: number;
    lastClaimTimestamp: number;
    currentWeight: string; // u128 as string to keep precision
    rewardDebt: string; // u128 as string to keep precision
}

type StakePositionAccount = {
    amount: { toString(): string };
    entryTradingDay: { toString(): string };
    lastClaimTimestamp: { toString(): string };
    currentWeight?: { toString(): string };
    rewardDebt?: { toString(): string };
};

type AccountNamespace = Record<
    string,
    { fetchNullable(key: PublicKey): Promise<unknown> } | undefined
>;

export function usePositions(mint: PublicKey | null) {
    const { publicKey } = useWallet();
    const program = useStakingProgram();
    const [positions, setPositions] = useState<Position[]>([]);
    const [loading, setLoading] = useState(false);

    const fetchPositions = useCallback(async () => {
        if (!publicKey || !program || !mint) {
            setPositions([]);
            return;
        }
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
            const userIndex = (await (program.account as AccountNamespace).userStakeIndex?.fetchNullable(
                userIndexPda,
            )) as { nextIndex: { toString(): string } } | null | undefined;
            const nextIndex = userIndex ? Number(userIndex.nextIndex) : 0;
            const fetched: Position[] = [];
            for (let i = 0; i < nextIndex; i++) {
                try {
                    const indexBytes = new BN(i).toArrayLike(Buffer, 'le', 8);
                    const [positionPda] = PublicKey.findProgramAddressSync([
                        Buffer.from('position'),
                        poolPda.toBuffer(),
                        publicKey.toBuffer(),
                        indexBytes,
                    ], STAKING_PROGRAM_ID);

                    const pos = (await (program.account as AccountNamespace).stakePosition?.fetchNullable(
                        positionPda,
                    )) as StakePositionAccount | null | undefined;
                    if (pos) {
                        fetched.push({
                            pda: positionPda,
                            index: i,
                            amount: Number(pos.amount),
                            entryTradingDay: Number(pos.entryTradingDay),
                            lastClaimTimestamp: Number(pos.lastClaimTimestamp),
                            currentWeight: pos.currentWeight ? pos.currentWeight.toString() : pos.amount.toString(),
                            rewardDebt: pos.rewardDebt ? pos.rewardDebt.toString() : '0',
                        });
                    }
                } catch (e) {
                    // Old positions have incompatible account data — skip them
                    console.warn(`Skipping position ${i}: stale account data (pre-upgrade layout)`, e);
                    continue;
                }
            }
            setPositions(fetched);
        } catch (e) {
            console.error('usePositions error:', e);
        } finally {
            setLoading(false);
        }
    }, [publicKey, program, mint]);

    useEffect(() => {
        // Deferred to a microtask so no setState runs synchronously inside the effect
        void Promise.resolve().then(fetchPositions);
    }, [fetchPositions]);

    return { positions, loading, refresh: fetchPositions };
}
