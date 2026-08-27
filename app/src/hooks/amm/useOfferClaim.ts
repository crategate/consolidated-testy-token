import { useCallback, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { BN } from '@coral-xyz/anchor';
import { PublicKey, Transaction } from '@solana/web3.js';
import {
    getAccount,
    getAssociatedTokenAddressSync,
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { STAKING_PROGRAM_ID, useAmmProgram } from '../../anchor/setup.ts';
import { formatUsdc } from './offerMath.ts';
import type { ClaimAccounts } from './useAmmData.ts';

export interface ClaimSelection {
    tier: number;   // 0 = sml, 1 = med, 2 = big
    units: number;
}

export type ClaimStatus = 'idle' | 'pending' | 'success' | 'error';

export interface UseOfferClaimReturn {
    claim: (selections: ClaimSelection[], estCostRaw: bigint) => Promise<boolean>;
    status: ClaimStatus;
    txSig: string | null;
    error: string | null;
    reset: () => void;
}

// One offerClaim instruction per selected tier, bundled into a single
// transaction (one wallet prompt). Each claim creates a new staking position,
// so the position index increments per instruction starting from the buyer's
// next_index (LE u64 at offset 8 of the user_index account; 0 if it doesn't
// exist yet — create_amm_position inits it via CPI).
export function useOfferClaim(accounts: ClaimAccounts | null, usdcDecimals: number): UseOfferClaimReturn {
    const { connection } = useConnection();
    const program = useAmmProgram();
    const [status, setStatus] = useState<ClaimStatus>('idle');
    const [txSig, setTxSig] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const reset = useCallback(() => {
        setStatus('idle');
        setTxSig(null);
        setError(null);
    }, []);

    const claim = useCallback(async (selections: ClaimSelection[], estCostRaw: bigint): Promise<boolean> => {
        if (!program || !accounts) return false;
        const active = selections.filter((s) => s.units > 0);
        if (active.length === 0) return false;

        setStatus('pending');
        setTxSig(null);
        setError(null);
        try {
            const buyer = program.provider.publicKey;
            const sendAndConfirm = program.provider.sendAndConfirm?.bind(program.provider);
            if (!buyer || !sendAndConfirm) throw new Error('Wallet not connected');

            const buyerUsdc = getAssociatedTokenAddressSync(accounts.usdcMint, buyer, false, TOKEN_PROGRAM_ID);
            let balance: bigint;
            try {
                balance = (await getAccount(connection, buyerUsdc, 'confirmed', TOKEN_PROGRAM_ID)).amount;
            } catch {
                throw new Error('No USDC token account found — fund this wallet with devnet USDC first.');
            }
            if (balance < estCostRaw) {
                throw new Error(
                    `Insufficient USDC: need ≈${formatUsdc(estCostRaw, usdcDecimals)}, have ${formatUsdc(balance, usdcDecimals)}.`
                );
            }

            const [userIndexPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('user_index'), buyer.toBuffer()], STAKING_PROGRAM_ID
            );
            let nextIndex = 0n;
            const userIndexInfo = await connection.getAccountInfo(userIndexPda);
            if (userIndexInfo && userIndexInfo.data.length >= 16) {
                nextIndex = new DataView(userIndexInfo.data.buffer, userIndexInfo.data.byteOffset)
                    .getBigUint64(8, true);
            }

            const tx = new Transaction();
            for (let i = 0; i < active.length; i++) {
                const { tier, units } = active[i];
                const index = nextIndex + BigInt(i);
                const [stakePositionPda] = PublicKey.findProgramAddressSync(
                    [
                        Buffer.from('position'),
                        accounts.stakingPool.toBuffer(),
                        buyer.toBuffer(),
                        new BN(index.toString()).toArrayLike(Buffer, 'le', 8),
                    ],
                    STAKING_PROGRAM_ID
                );
                tx.add(
                    await program.methods
                        .offerClaim(tier, units, new BN(index.toString()))
                        .accounts({
                            buyer,
                            ammState: accounts.ammState,
                            offerList: accounts.offerList,
                            afhoMint: accounts.afhoMint,
                            usdcMint: accounts.usdcMint,
                            spotOracle: accounts.spotOracle,
                            marketStatus: accounts.marketStatus,
                            buyerUsdc,
                            ammUsdcVault: accounts.ammUsdcVault,
                            usdcDip: accounts.usdcDip,
                            usdcRewards: accounts.usdcRewards,
                            cpmmPoolState: accounts.cpmmPoolState,
                            cpmmObservation: accounts.cpmmObservation,
                            cpmmInputVault: accounts.cpmmInputVault,
                            cpmmOutputVault: accounts.cpmmOutputVault,
                            stakingProgram: STAKING_PROGRAM_ID,
                            stakingPool: accounts.stakingPool,
                            userIndex: userIndexPda,
                            stakePosition: stakePositionPda,
                            ammAfhoVault: accounts.ammAfhoVault,
                            stakingVault: accounts.stakingVault,
                            tokenProgram: TOKEN_PROGRAM_ID,
                            token2022Program: TOKEN_2022_PROGRAM_ID,
                        })
                        .instruction()
                );
            }

            const sig = await sendAndConfirm(tx);
            setTxSig(sig);
            setStatus('success');
            return true;
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Claim transaction failed');
            setStatus('error');
            return false;
        }
    }, [program, accounts, connection, usdcDecimals]);

    return { claim, status, txSig, error, reset };
}
