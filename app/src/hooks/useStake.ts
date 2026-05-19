import { useCallback } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { useStakingProgram, STAKING_PROGRAM_ID, CRANK_PROGRAM_ID } from '../anchor/setup';
import { PublicKey, SystemProgram, } from '@solana/web3.js';
import BN from 'bn.js'
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

export function useStake(mint: PublicKey | null) {
    const { publicKey } = useWallet();
    const { connection } = useConnection();
    const program = useStakingProgram();

    const stake = useCallback(async (amount: string) => {
        if (!publicKey || !program || !mint || !connection || !amount) {
            throw new Error('Wallet not connected or missing params');
        }

        const [poolPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('pool'), mint.toBuffer()],
            STAKING_PROGRAM_ID
        );
        const [userIndexPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('user_index'), publicKey.toBuffer()],
            STAKING_PROGRAM_ID
        );

        const userIndex = await (program.account as any).userStakeIndex?.fetchNullable(userIndexPda);
        const index = userIndex ? Number(userIndex.nextIndex) : 0;

        const [positionPda] = PublicKey.findProgramAddressSync([
            Buffer.from('position'),
            poolPda.toBuffer(),
            publicKey.toBuffer(),
            new BN(index).toArrayLike(Buffer, 'le', 8),
        ], STAKING_PROGRAM_ID);
        const [vaultPda] = PublicKey.findProgramAddressSync([
            Buffer.from('vault'),
            poolPda.toBuffer(),
        ], program.programId);

        const ownerToken = getAssociatedTokenAddressSync(mint, publicKey, false, TOKEN_2022_PROGRAM_ID);
        const [marketStatus] = PublicKey.findProgramAddressSync(
            [Buffer.from('market_status')],
            CRANK_PROGRAM_ID
        );
        const stakeAmount = new BN(Number(amount) * 1e9); // assumes 9 decimals
        console.log("Program ID used for PDAs :", STAKING_PROGRAM_ID.toBase58());
        console.log("Program ID from IDL/tx   :", program.programId.toBase58());
        console.log("Pool PDA                 :", poolPda.toBase58());
        console.log("Position PDA             :", positionPda.toBase58());
        console.log("Index                    :", index);
        const tx = await program.methods
            .stake(stakeAmount, new BN(index))
            .accounts({
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
            })
            .rpc();

        return tx;
    }, [publicKey, program, mint, connection]);

    return { stake };
}
