import { useCallback } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { useStakingProgram, STAKING_PROGRAM_ID, CRANK_PROGRAM_ID } from '../anchor/setup';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import BN from 'bn.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

export function useStake(mint: PublicKey | null, marketStatusPda?: PublicKey) {
    const { publicKey } = useWallet();
    const { connection } = useConnection();
    const program = useStakingProgram();

    const stake = useCallback(async (amount: string) => {
        if (!publicKey || !program || !mint || !connection || !amount) {
            throw new Error('Wallet not connected or missing params');
        }

        // Derive PDAs using the exported constant (same as program.programId, but explicit)
        const [poolPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('pool'), mint.toBuffer()],
            STAKING_PROGRAM_ID
        );
        const [userIndexPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('user_index'), publicKey.toBuffer()],
            STAKING_PROGRAM_ID
        );
        const [vaultPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('vault'), poolPda.toBuffer()],
            STAKING_PROGRAM_ID
        );
        const marketStatus = marketStatusPda ?? PublicKey.findProgramAddressSync(
            [Buffer.from('market_status')],
            CRANK_PROGRAM_ID
        )[0];

        // Fetch user index to know which position index to create
        let userIndex = null;
        try {
            userIndex = await (program.account as any).userStakeIndex?.fetchNullable(userIndexPda);
        } catch (e) {
            console.log('No existing userIndex account (expected for first stake)');
        }
        const index = userIndex ? Number(userIndex.nextIndex) : 0;

        const indexBytes = new BN(index).toArrayLike(Buffer, 'le', 8);

        const [positionPda] = PublicKey.findProgramAddressSync([
            Buffer.from('position'),
            poolPda.toBuffer(),
            publicKey.toBuffer(),
            indexBytes,
        ], STAKING_PROGRAM_ID);

        const ownerToken = getAssociatedTokenAddressSync(mint, publicKey, false, TOKEN_2022_PROGRAM_ID);
        const stakeAmount = new BN(Number(amount) * 1e9);

        // ─── DEBUG LOGS ───
        console.group('🔍 STAKE DEBUG');
        console.log('STAKING_PROGRAM_ID :', STAKING_PROGRAM_ID.toBase58());
        console.log('program.programId  :', program.programId.toBase58());
        console.log('CRANK_PROGRAM_ID   :', CRANK_PROGRAM_ID.toBase58());
        console.log('mint               :', mint.toBase58());
        console.log('poolPda            :', poolPda.toBase58());
        console.log('userIndexPda       :', userIndexPda.toBase58());
        console.log('vaultPda           :', vaultPda.toBase58());
        console.log('marketStatus       :', marketStatus.toBase58());
        console.log('owner (wallet)     :', publicKey.toBase58());
        console.log('ownerToken         :', ownerToken.toBase58());
        console.log('index (decimal)    :', index);
        console.log('index (hex LE)     :', indexBytes.toString('hex'));
        console.log('positionPda        :', positionPda.toBase58());
        console.log('stakeAmount        :', stakeAmount.toString());
        console.groupEnd();
        // ──────────────────

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

        //     const tx = await program.methods
        //         .stake(stakeAmount, new BN(index), 0)
        //         .accounts({
        //             owner: publicKey,
        //             mint,
        //             pool: poolPda,
        //             userIndex: userIndexPda,
        //             position: positionPda,
        //             ownerToken,
        //             vault: vaultPda,
        //             marketStatus,
        //             tokenProgram: TOKEN_2022_PROGRAM_ID,
        //             systemProgram: SystemProgram.programId,
        //         })
        //         .transaction();  // <-- build tx, don't send yet

        //     tx.recentBlockhash = blockhash;
        //     tx.feePayer = publicKey;

        // Phantom will sign and send
        const signature = await program.methods.stake(stakeAmount, new BN(index), 0).accounts({
            owner: publicKey,
            mint,
            pool: poolPda,
            userIndex: userIndexPda,
            position: positionPda,
            ownerToken,
            vault: vaultPda,
            marketStatus,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
        }).rpc({
            skipPreflight: false,
            preflightCommitment: 'confirmed',
            maxRetries: 3,
        });

        // Wait for confirmation with the same blockhash parameters
        await connection.confirmTransaction(
            { signature, blockhash, lastValidBlockHeight },
            'confirmed'
        );

        return signature;
    }, [publicKey, program, mint, connection, marketStatusPda]);

    return { stake };
}
