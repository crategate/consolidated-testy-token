import { useMemo } from 'react';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { usePool } from './usePool';
import { useMarketStatus } from './useMarketStatus';
import type { Position } from './usePositions';

export interface EnrichedPosition extends Position {
    multiplierBps: number;
    multiplierDisplay: string;
    tradingDays: number;
    weight: number;
    grossRewardRaw: number;
    penaltyBps: number;
    penaltyRaw: number;
    posrTaxRaw: number;
    netRewardRaw: number;
    netRewardDisplay: string;
}

export function usePositionRewards(mint: PublicKey | null, positions: Position[], marketStatusPda?: PublicKey) {
    const { pool } = usePool(mint);
    const { data: marketData } = useMarketStatus(marketStatusPda);

    const enriched: EnrichedPosition[] = useMemo(() => {
        if (!pool || !marketData || !positions.length) return [];

        const currentTradingDay = marketData.tradingDay;
        const maxMultiplierBps = Number(pool.maxMultiplierBps);
        const posrTaxBps = Number(pool.posrTaxBps);
        const accPerShare = new BN(pool.accruedRewardPerShare.toString());
        const SCALE = new BN(10).pow(new BN(12));

        return positions.map(pos => {
            const amount = pos.amount;
            const entryDay = pos.entryTradingDay;
            const tradingDays = Math.max(0, currentTradingDay - entryDay - 1);

            // Same curve as the Rust program: base + (days * range) / (days + 60)
            const base = 10000;
            const range = Math.max(0, maxMultiplierBps - base);
            const multiplier = base + Math.floor((tradingDays * range) / (tradingDays + 60));

            // Display weight previews the next checkpointed weight.
            const weight = Math.floor((amount * multiplier) / 10000);

            // Claimable rewards use the on-chain checkpointed weight so older
            // reward distributions are not re-counted as multipliers grow.
            const weightBN = new BN(pos.currentWeight);
            const accumulated = weightBN.mul(accPerShare).div(SCALE);
            const rewardDebt = new BN(pos.rewardDebt);
            const gross = accumulated.gt(rewardDebt) ? accumulated.sub(rewardDebt) : new BN(0);

            // Claims are market-open only. No tiered claim penalty is applied.
            const posrTax = gross.muln(posrTaxBps).divn(10000);
            const net = gross.sub(posrTax);

            const grossNum = parseFloat(gross.toString()) / 1e9;
            const posrTaxNum = parseFloat(posrTax.toString()) / 1e9;
            const netNum = parseFloat(net.toString()) / 1e9;

            return {
                ...pos,
                multiplierBps: multiplier,
                multiplierDisplay: (multiplier / 10000).toFixed(2),
                tradingDays,
                weight,
                grossRewardRaw: grossNum,
                penaltyBps: 0,
                penaltyRaw: 0,
                posrTaxRaw: posrTaxNum,
                netRewardRaw: netNum,
                netRewardDisplay: `${netNum.toFixed(4)} NYSEH`,
            };
        });
    }, [pool, marketData, positions]);

    const grandTotal = useMemo(() => {
        return enriched.reduce((sum, pos) => sum + pos.netRewardRaw, 0);
    }, [enriched]);

    return { enriched, grandTotal, pool, marketData };
}
