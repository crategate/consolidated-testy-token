import { useCallback, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { BN } from '@coral-xyz/anchor';
import { ComputeBudgetProgram, PublicKey, SendTransactionError, SystemProgram, Transaction } from '@solana/web3.js';
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

            // ── Pre-flight the on-chain gates against FRESH state ──
            // The wallet's preflight simulation runs the real claim logic,
            // whose gates (DeskClosed / StaleOfferSheet / InsufficientOffer)
            // read the market-status PDA and the sheet AT EXECUTION TIME. The
            // UI's polled snapshot can be stale at click time (in watch mode
            // the state only moves on a manual set-oracle flip), so a click
            // that passed the UI gate can still fail the wallet's simulation — and the wallet's
            // immediate "try again" re-simulates the SAME transaction, failing
            // again. Re-read both accounts here and fail with an actionable
            // message instead of a raw simulation error.
            const statusInfo = await connection.getAccountInfo(accounts.marketStatus);
            const onChainState = statusInfo && statusInfo.data.length >= 9 ? statusInfo.data[8] : 99;
            if (onChainState !== 1 && onChainState !== 2) {
                throw new Error(
                    `The desk just closed (market state ${onChainState}) — offers are claimable in ` +
                        'after-hours (1) and closed (2) sessions only. Try again once the state cycles back.'
                );
            }
            const freshSheet = (await program.account.offerList.fetch(
                accounts.offerList
            )) as unknown as Record<string, unknown>;
            const tierNames = ['sml', 'med', 'big'] as const;
            for (const s of active) {
                const name = tierNames[s.tier];
                const offer = (freshSheet[`${name}Offer`] ?? freshSheet[`${name}_offer`]) as
                    | { remaining: number }
                    | undefined;
                const remaining = offer ? Number(offer.remaining) : 0;
                if (remaining < s.units) {
                    throw new Error(
                        `Only ${remaining} lot(s) remain in that tier — someone claimed while you were checking out. Pick a smaller amount or another tier.`
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
            // Raise the CU ceiling: a transaction with no compute-budget
            // instruction defaults to 200k CU per instruction. The limit is
            // free — fees bill CONSUMED CU, not the limit.
            tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }));
            // Chunking: the USDC instruction is ~950 bytes, so all tiers fit in
            // one transaction. A single SOL instruction is ~1180 bytes (+33 for
            // the CPMM program remaining account), so two would exceed the
            // 1232-byte packet limit — SOL claims go out as one transaction per
            // tier (one wallet prompt each).
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
                    // NOTE: no compute-budget instruction here. This tx is
                    // ~1213 bytes — only ~19 under the 1232-byte packet
                    // limit — and a ComputeBudgetProgram instruction costs
                    // ~41 bytes, pushing serialization to 1254 > 1232
                    // ("Transaction too large"). If the 200k per-instruction
                    // CU default ever actually binds here, the durable fix is
                    // a v0 transaction + address lookup table, not a CB ix.
                    const solIx = await program.methods
                        .offerClaimSol(tier, units, new BN(index.toString()))
                        .accounts({
                            buyer,
                            ammState: accounts.ammState,
                            offerList: accounts.offerList,
                            afhoMint: accounts.afhoMint,
                            usdcMint: accounts.usdcMint,
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
                            // Pool-only pricing: the pinned-pool accounts are
                            // the only price sources (the mock oracles are gone
                            // from the program). Anchor optional accounts must
                            // still be passed, and programId is the sentinel
                            // that means "omitted". Because they live at the
                            // end of the account list, the sentinel does not
                            // shift any required account.
                            cpmmPoolState: accounts.cpmmPoolState,
                            cpmmObservation: accounts.cpmmObservation,
                            cpmmInputVault: accounts.cpmmInputVault,
                            cpmmOutputVault: accounts.cpmmOutputVault,
                        })
                        // The program CPIs the wSOL→USDC swap into
                        // amm_state.cpmm_program (Raydium CPMM). Solana's
                        // runtime refuses a CPI unless the callee program id
                        // is itself among the caller instruction's accounts
                        // (otherwise: "Unknown program DRay…" +
                        // "An account required by the instruction is missing").
                        // The deployed amm program has no struct slot for it,
                        // so pass it as a read-only remaining account — it is
                        // appended after the optional-account sentinels and
                        // never consumed by Anchor's account deserializer.
                        .remainingAccounts([
                            {
                                pubkey: sol.cpmmProgram,
                                isSigner: false,
                                isWritable: false,
                            },
                        ])
                        .instruction();
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
            let message = err instanceof Error ? err.message : 'Claim transaction failed';
            // Anchor/Solana transaction errors carry simulator logs; surface them
            // so the UI shows the same detail the wallet would show on simulation.
            if (err instanceof SendTransactionError) {
                try {
                    const logs = await err.getLogs(connection);
                    if (logs && logs.length > 0) {
                        message = `${message}\n\nLogs:\n${logs.join('\n')}`;
                    }
                } catch {
                    // getLogs can fail if the connection is gone; keep the original message.
                }
            } else if (
                err &&
                typeof err === 'object' &&
                'logs' in err &&
                Array.isArray((err as { logs: string[] }).logs)
            ) {
                const logs = (err as { logs: string[] }).logs;
                message = `${message}\n\nLogs:\n${logs.join('\n')}`;
            }
            setError(message);
            setStatus('error');
            return false;
        }
    }, [program, accounts, solAccounts, connection, usdcDecimals]);

    return { claim, status, txSig, error, reset };
}
