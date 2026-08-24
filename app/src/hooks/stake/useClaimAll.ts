import { useCallback, useState } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { useStakingProgram, STAKING_PROGRAM_ID, CRANK_PROGRAM_ID } from '../../anchor/setup';
import { PublicKey, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import type { Position } from './usePositions';

export function useClaimAll(mint: PublicKey | null, positions: Position[], marketStatusPda?: PublicKey) {
    const { publicKey } = useWallet();
    const { connection } = useConnection();
    const program = useStakingProgram();
    const [loading, setLoading] = useState(false);

    const claimAll = useCallback(async () => {
        if (!publicKey || !program || !mint || !positions.length || !connection) {
            throw new Error('Wallet not connected or missing parameters');
        }

        setLoading(true);
        try {
            const [poolPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('pool'), mint.toBuffer()],
                STAKING_PROGRAM_ID
            );
            const [rewardVaultPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('rewards'), poolPda.toBuffer()],
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

            const tx = new Transaction();
            const { blockhash } = await connection.getLatestBlockhash('confirmed');
            tx.recentBlockhash = blockhash;
            tx.feePayer = publicKey;

            for (const position of positions) {
                const ix = await program.methods
                    .claim()
                    .accounts({
                        owner: publicKey,
                        mint,
                        pool: poolPda,
                        position: position.pda,
                        rewardVault: rewardVaultPda,
                        afhoVault: posrVaultPda,
                        ownerToken,
                        marketStatus,
                        tokenProgram: TOKEN_2022_PROGRAM_ID,
                    })
                    .instruction();
                tx.add(ix);
            }

            const sendAndConfirm = program.provider.sendAndConfirm?.bind(program.provider);
            if (!sendAndConfirm) throw new Error('Provider cannot send transactions');
            const signature = await sendAndConfirm(tx);
            return signature;
        } catch (e) {
            console.error('Claim all error:', e);
            throw e;
        } finally {
            setLoading(false);
        }
    }, [publicKey, program, mint, positions, connection, marketStatusPda]);

    return { claimAll, loading };
}