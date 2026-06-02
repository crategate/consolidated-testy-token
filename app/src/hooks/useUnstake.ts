import { useCallback, useState } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { useStakingProgram, STAKING_PROGRAM_ID, CRANK_PROGRAM_ID } from '../anchor/setup';
import type { Position } from './usePositions';

function principalPenaltyBpsForState(state?: number) {
    if (state === 1) return 300;
    if (state === 2) return 700;
    if (state === 3) return 1800;
    return 0;
}

export function useUnstake(mint: PublicKey | null, marketStatusPda?: PublicKey, marketState?: number) {
    const { publicKey } = useWallet();
    const { connection } = useConnection();
    const program = useStakingProgram();
    const [loadingIndex, setLoadingIndex] = useState<number | null>(null);

    const unstake = useCallback(async (position: Position) => {
        if (!publicKey || !program || !mint || !connection) {
            throw new Error('Wallet not connected or missing parameters');
        }

        setLoadingIndex(position.index);
        try {
            const [poolPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('pool'), mint.toBuffer()],
                STAKING_PROGRAM_ID
            );
            const [vaultPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('vault'), poolPda.toBuffer()],
                STAKING_PROGRAM_ID
            );
            const [rewardVaultPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('rewards'), poolPda.toBuffer()],
                STAKING_PROGRAM_ID
            );
            const [penaltyVaultPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('penalties'), poolPda.toBuffer()],
                STAKING_PROGRAM_ID
            );
            const [posrVaultPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('posr'), poolPda.toBuffer()],
                STAKING_PROGRAM_ID
            );
            const marketStatus = marketStatusPda ?? PublicKey.findProgramAddressSync(
                [Buffer.from('market_status')],
                CRANK_PROGRAM_ID
            )[0];
            const ownerToken = getAssociatedTokenAddressSync(mint, publicKey, false, TOKEN_2022_PROGRAM_ID);
            const penaltyBps = principalPenaltyBpsForState(marketState);
            const principalPenaltyRaw = Math.floor(position.amount * penaltyBps / 10000);

            console.log('Exit stake transaction', {
                position: position.pda.toBase58(),
                index: position.index,
                amountRaw: position.amount,
                marketState,
                principalPenaltyBps: penaltyBps,
                principalPenaltyRaw,
                principalPenaltyDisplay: `${(principalPenaltyRaw / 1e9).toFixed(4)} NYSEH`,
                pool: poolPda.toBase58(),
                vault: vaultPda.toBase58(),
                rewardVault: rewardVaultPda.toBase58(),
                posrVault: posrVaultPda.toBase58(),
                marketStatus: marketStatus.toBase58(),
            });

            const signature = await program.methods
                .unstake()
                .accounts({
                    owner: publicKey,
                    mint,
                    pool: poolPda,
                    position: position.pda,
                    vault: vaultPda,
                    rewardVault: rewardVaultPda,
                    penaltyVault: penaltyVaultPda,
                    posrVault: posrVaultPda,
                    ownerToken,
                    marketStatus,
                    tokenProgram: TOKEN_2022_PROGRAM_ID,
                })
                .rpc({
                    skipPreflight: false,
                    preflightCommitment: 'confirmed',
                    maxRetries: 3,
                });

            return signature;
        } finally {
            setLoadingIndex(null);
        }
    }, [publicKey, program, mint, connection, marketStatusPda, marketState]);

    return { unstake, loadingIndex };
}
