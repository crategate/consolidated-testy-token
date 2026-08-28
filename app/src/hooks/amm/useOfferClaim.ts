import { useCallback, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { BN } from '@coral-xyz/anchor';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getAccount,
    getAssociatedTokenAddressSync,
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { STAKING_PROGRAM_ID, useAmmProgram } from '../../anchor/setup.ts';
import { formatSol, formatUsdc, lamportsForCost } from './offerMath.ts';
import type { ClaimAccounts, SolClaimAccounts } from './useAmmData.ts';

export interface ClaimSelection {
    tier: number;   // 0 = sml, 1 = med, 2 = big
    units: number;
}

export type ClaimCurrency = 'usdc' | 'sol';

export type ClaimStatus = 'idle' | 'pending' | 'success' | 'error';

export interface UseOfferClaimReturn {
    claim: (
        selections: ClaimSelection[],
        estCostRaw: bigint,
        opts: { currency: ClaimCurrency; solPrice: bigint | null },
    ) => Promise<boolean>;
    status: ClaimStatus;
    txSig: string | null;
    error: string | null;
    reset: () => void;
}

// One claim instruction per selected tier, bundled into a single transaction
// (one wallet prompt). Each claim creates a new staking position, so the
// position index increments per instruction starting from the buyer's
// next_index (LE u64 at offset 8 of the user_index account; 0 if it doesn't
// exist yet — create_amm_position inits it via CPI).
//
// Payment currency: 'usdc' → offer_claim (buyer's USDC ATA). 'sol' →
// offer_claim_sol (buyer lamports → wSOL → CPMM swap to USDC, buyer covers the
// 0.25% swap fee; requires the pinned SOL/USDC pool = solAccounts).
export function useOfferClaim(
    accounts: ClaimAccounts | null,
    solAccounts: SolClaimAccounts | null,
    usdcDecimals: number,
): UseOfferClaimReturn {
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

    const claim = useCallback(async (
        selections: ClaimSelection[],
        estCostRaw: bigint,
        opts: { currency: ClaimCurrency; solPrice: bigint | null },
    ): Promise<boolean> => {
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

            const currency = opts.currency;
            // Captured parameter — copy to a local so TS can narrow it below.
            const sol = solAccounts;
            if (currency === 'sol' && !sol) {
                throw new Error('SOL payments need the SOL/USDC pool pinned — run anchor run set-sol-usdc-pool.');
            }

            // ── balance gate ──
            if (currency === 'usdc') {
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
            } else {
                if (!sol) {
                    throw new Error('SOL payments need the SOL/USDC pool pinned — run anchor run set-sol-usdc-pool.');
                }
                if (!opts.solPrice || opts.solPrice <= 0n) {
                    throw new Error('SOL price unavailable — cannot estimate the SOL cost.');
                }
                const lamportsEst = lamportsForCost(estCostRaw, opts.solPrice);
                const haveLamports = await connection.getBalance(buyer);
                if (BigInt(haveLamports) < lamportsEst) {
                    throw new Error(
                        `Insufficient SOL: need ≈${formatSol(lamportsEst)} SOL, have ${formatSol(BigInt(haveLamports))} SOL.`
                    );
                }
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
            // Chunking: the USDC instruction is ~950 bytes, so all tiers fit in
            // one transaction. A single SOL instruction is ~1180 bytes — two
            // would exceed the 1232-byte packet limit, so SOL claims go out as
            // one transaction per tier (one wallet prompt each).
            const txs: Transaction[] = currency === 'usdc' ? [tx] : [];
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
                if (currency === 'usdc') {
                    const buyerUsdc = getAssociatedTokenAddressSync(accounts.usdcMint, buyer, false, TOKEN_PROGRAM_ID);
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
                                systemProgram: SystemProgram.programId,
                            })
                            .instruction()
                    );
                } else {
                    if (!sol) {
                        throw new Error('SOL payments need the SOL/USDC pool pinned — run anchor run set-sol-usdc-pool.');
                    }
                    const solTx = new Transaction();
                    const solIx = await program.methods
                        .offerClaimSol(tier, units, new BN(index.toString()))
                        .accounts({
                            buyer,
                            ammState: accounts.ammState,
                            offerList: accounts.offerList,
                            afhoMint: accounts.afhoMint,
                            usdcMint: accounts.usdcMint,
                            // spot/sol oracles are Option on-chain and unused
                            // while both pools are pinned (the UI only enables
                            // SOL then). anchor 0.31 can't omit optional
                            // accounts — passing the program id marks them
                            // optional, then we drop those metas so the
                            // instruction stays under the 1232-byte limit
                            // (34 accounts serializes to 1244 bytes; the
                            // pinned path needs neither oracle).
                            spotOracle: program.programId,
                            solOracle: program.programId,
                            cpmmPoolState: accounts.cpmmPoolState,
                            cpmmObservation: accounts.cpmmObservation,
                            cpmmInputVault: accounts.cpmmInputVault,
                            cpmmOutputVault: accounts.cpmmOutputVault,
                            marketStatus: accounts.marketStatus,
                            usdcVault: accounts.ammUsdcVault,
                            usdcDip: accounts.usdcDip,
                            usdcRewards: accounts.usdcRewards,
                            wsolVault: sol.wsolVault,
                            wrappedSolMint: sol.wrappedSolMint,
                            solUsdcPoolState: sol.solUsdcPoolState,
                            solUsdcAmmConfig: sol.solUsdcAmmConfig,
                            solUsdcInputVault: sol.solUsdcInputVault,
                            solUsdcOutputVault: sol.solUsdcOutputVault,
                            solUsdcObservation: sol.solUsdcObservation,
                            solUsdcAuthority: sol.solUsdcAuthority,
                            stakingProgram: STAKING_PROGRAM_ID,
                            stakingPool: accounts.stakingPool,
                            userIndex: userIndexPda,
                            stakePosition: stakePositionPda,
                            ammAfhoVault: accounts.ammAfhoVault,
                            stakingVault: accounts.stakingVault,
                            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                            tokenProgram: TOKEN_PROGRAM_ID,
                            token2022Program: TOKEN_2022_PROGRAM_ID,
                            systemProgram: SystemProgram.programId,
                        })
                        .instruction();
                    solIx.keys = solIx.keys.filter((m) => !m.pubkey.equals(program.programId));
                    solTx.add(solIx);
                    txs.push(solTx);
                }
            }

            // One wallet prompt per transaction.
            let lastSig: string | null = null;
            for (const t of txs) {
                lastSig = await sendAndConfirm(t);
            }
            if (!lastSig) throw new Error('Claim produced no transactions');
            setTxSig(lastSig);
            setStatus('success');
            return true;
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Claim transaction failed');
            setStatus('error');
            return false;
        }
    }, [program, accounts, solAccounts, connection, usdcDecimals]);

    return { claim, status, txSig, error, reset };
}
