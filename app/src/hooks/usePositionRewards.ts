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

export function usePositionRewards(mint: PublicKey | null, positions: Position[]) {
    const { pool } = usePool(mint);
    const { data: marketData } = useMarketStatus();

    const enriched: EnrichedPosition[] = useMemo(() => {
        if (!pool || !marketData || !positions.length) return [];

        const currentTradingDay = marketData.tradingDay;
        const marketState = marketData.state;
        const maxMultiplierBps = Number(pool.maxMultiplierBps);
        const posrTaxBps = Number(pool.posrTaxBps);
        const accPerShare = new BN(pool.accruedRewardPerShare.toString());
        const SCALE = new BN(10).pow(new BN(12));

        let penaltyBps = 0;
        if (marketState === 1) penaltyBps = Number(pool.afterHoursPenaltyBps);
        else if (marketState === 2) penaltyBps = Number(pool.closedPenaltyBps);
        else if (marketState === 3) penaltyBps = Number(pool.haltedPenaltyBps);

        return positions.map(pos => {
            const amount = pos.amount;
            const entryDay = pos.entryTradingDay;
            const tradingDays = Math.max(0, currentTradingDay - entryDay - 1);

            // Same curve as the Rust program: base + (days * range) / (days + 60)
            const base = 10000;
            const range = Math.max(0, maxMultiplierBps - base);
            const multiplier = base + Math.floor((tradingDays * range) / (tradingDays + 60));

            // Weight = amount * multiplier / 10000
            const weight = Math.floor((amount * multiplier) / 10000);

            // MasterChef math: (weight * accPerShare) / 1e12 - rewardDebt
            const weightBN = new BN(weight);
            const accumulated = weightBN.mul(accPerShare).div(SCALE);
            const rewardDebt = new BN(pos.rewardDebt);
            const gross = accumulated.gt(rewardDebt) ? accumulated.sub(rewardDebt) : new BN(0);

            // Apply live penalty + POSR tax so users see what they'd actually receive
            const penalty = gross.muln(penaltyBps).divn(10000);
            const afterPenalty = gross.sub(penalty);
            const posrTax = afterPenalty.muln(posrTaxBps).divn(10000);
            const net = afterPenalty.sub(posrTax);

            const grossNum = parseFloat(gross.toString()) / 1e9;
            const penaltyNum = parseFloat(penalty.toString()) / 1e9;
            const posrTaxNum = parseFloat(posrTax.toString()) / 1e9;
            const netNum = parseFloat(net.toString()) / 1e9;

            return {
                ...pos,
                multiplierBps: multiplier,
                multiplierDisplay: (multiplier / 10000).toFixed(2),
                tradingDays,
                weight,
                grossRewardRaw: grossNum,
                penaltyBps,
                penaltyRaw: penaltyNum,
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
