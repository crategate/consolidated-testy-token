import { useCallback, useMemo } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { Connection, PublicKey } from '@solana/web3.js';
import { BorshAccountsCoder, type Idl } from '@coral-xyz/anchor';
import { useQuery } from '@tanstack/react-query';
import crankIdl from '../../../target/idl/crank_oracle.json';
import ammIdl from '../../../target/idl/amm.json';
import { useChainData } from '../context/useChainData';
import {
    AMM_PROGRAM_ID,
    CRANK_PROGRAM_ID,
    field,
    type AmmStateData,
    type MarketStatusData,
    type OfferListData,
    type StakePoolData,
} from '../context/chainDataHelpers';
import type { ResolvedDeployment } from '../config';

export type DashField = { label: string; value: string };

export type DashSection = {
    title: string;
    initialized: boolean;
    fields: DashField[];
    addresses: DashField[];
};

export type DashData = {
    sections: DashSection[];
    missing: string[];
    updatedAt: string;
};

const crankCoder = new BorshAccountsCoder(crankIdl as Idl);
const ammCoder = new BorshAccountsCoder(ammIdl as Idl);

function u64At(data: Uint8Array, offset: number): bigint {
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);
}

function u32At(data: Uint8Array, offset: number): number {
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

function tokenAmount(data: Uint8Array): bigint {
    return u64At(data, 64);
}

function fmtToken(raw: unknown, decimals: number): string {
    const n = Number(String(raw ?? 0)) / 10 ** decimals;
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtSol(raw: unknown): string {
    return (Number(String(raw ?? 0)) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 4 }) + ' SOL';
}

function fmtTs(unix: unknown): string {
    const n = Number(String(unix ?? 0));
    if (!n) return 'never';
    return new Date(n * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function pk(value?: string): PublicKey | null {
    if (!value) return null;
    try {
        return new PublicKey(value);
    } catch {
        return null;
    }
}

interface RemainingAccounts {
    mintInfo: { data: Uint8Array; lamports: number } | null;
    acceptedOffers: { data: Uint8Array; lamports: number } | null;
    metrics: { data: Uint8Array; lamports: number } | null;
    ammAfhoVault: { data: Uint8Array; lamports: number } | null;
    ammUsdcVault: { data: Uint8Array; lamports: number } | null;
    ammSolVault: { data: Uint8Array; lamports: number } | null;
    usdcDip: { data: Uint8Array; lamports: number } | null;
    solDip: { data: Uint8Array; lamports: number } | null;
    stakeVault: { data: Uint8Array; lamports: number } | null;
    rewardVault: { data: Uint8Array; lamports: number } | null;
    penaltyVault: { data: Uint8Array; lamports: number } | null;
    posrVault: { data: Uint8Array; lamports: number } | null;
    bountyConfig: { data: Uint8Array; lamports: number } | null;
    bountyVault: { data: Uint8Array; lamports: number } | null;
}

async function fetchRemainingAccounts(
    connection: Connection,
    deployment: ResolvedDeployment,
    ammProgram: PublicKey,
    crankProgram: PublicKey,
): Promise<RemainingAccounts> {
    const mint = deployment.mintKey;

    const [acceptedOffersPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('accepted_offers'), mint.toBuffer()],
        ammProgram,
    );
    const [metricsPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('metrics'), mint.toBuffer()],
        ammProgram,
    );
    const [bountyConfigPda] = PublicKey.findProgramAddressSync([Buffer.from('bounty_config')], crankProgram);
    const [bountyVaultPda] = PublicKey.findProgramAddressSync([Buffer.from('bounty_vault')], crankProgram);
    // 10% dip-reserve vaults (buy_the_dip spends from these). Same derivation
    // amm-init / initialize_amm use: a PDA token account (USDC) and a
    // space-0 system PDA (SOL).
    const [usdcDipPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('amm_usdc_dip'), mint.toBuffer()],
        ammProgram,
    );
    const [solDipPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('amm_sol_dip'), mint.toBuffer()],
        ammProgram,
    );

    const keys = [
        mint,
        acceptedOffersPda,
        metricsPda,
        pk(deployment.ammAfhoVault),
        pk(deployment.ammUsdcVault),
        pk(deployment.ammSolVault),
        usdcDipPda,
        solDipPda,
        pk(deployment.vault),
        pk(deployment.rewardVault),
        pk(deployment.penaltyVault),
        pk(deployment.posrVault),
        bountyConfigPda,
        bountyVaultPda,
    ].filter((k): k is PublicKey => k !== null);

    const names = [
        'mint',
        'acceptedOffers',
        'metrics',
        'ammAfhoVault',
        'ammUsdcVault',
        'ammSolVault',
        'usdcDip',
        'solDip',
        'stakeVault',
        'rewardVault',
        'penaltyVault',
        'posrVault',
        'bountyConfig',
        'bountyVault',
    ];

    const infos = await connection.getMultipleAccountsInfo(keys);
    const account = (name: string) => {
        const idx = names.indexOf(name);
        return infos[idx] ?? null;
    };

    return {
        mintInfo: account('mint'),
        acceptedOffers: account('acceptedOffers'),
        metrics: account('metrics'),
        ammAfhoVault: account('ammAfhoVault'),
        ammUsdcVault: account('ammUsdcVault'),
        ammSolVault: account('ammSolVault'),
        usdcDip: account('usdcDip'),
        solDip: account('solDip'),
        stakeVault: account('stakeVault'),
        rewardVault: account('rewardVault'),
        penaltyVault: account('penaltyVault'),
        posrVault: account('posrVault'),
        bountyConfig: account('bountyConfig'),
        bountyVault: account('bountyVault'),
    };
}

function buildDashData(
    deployment: ResolvedDeployment,
    marketStatus: MarketStatusData | null,
    pool: StakePoolData | null,
    ammState: AmmStateData | null,
    offerList: OfferListData | null,
    remaining: RemainingAccounts,
    ammProgram: PublicKey,
    crankProgram: PublicKey,
): DashData {
    const missing: string[] = [];

    const mintInfo = remaining.mintInfo;
    let decimals = 9;
    let mintSupply = 0n;
    let mintAuthRenounced = false;
    if (mintInfo && mintInfo.data.length >= 82) {
        mintSupply = u64At(mintInfo.data, 36);
        decimals = mintInfo.data[44];
        mintAuthRenounced = u32At(mintInfo.data, 0) === 0;
    }
    if (!mintInfo) missing.push('mint');

    const token = (info: { data: Uint8Array } | null): bigint | null => {
        return info && info.data.length >= 72 ? tokenAmount(info.data) : null;
    };

    // ---- Offer sheet ----
    const offerFields: DashField[] = [];
    if (offerList) {
        for (const [label, key] of [
            ['Big', 'big'],
            ['Med', 'med'],
            ['Sml', 'sml'],
        ] as const) {
            const o = field<Record<string, unknown>>(offerList, `${key}Offer`, `${key}_offer`);
            if (o) {
                offerFields.push({
                    label: `${label} offer`,
                    value: `lot ${field(o, 'lotSize', 'lot_size')} · vest ${field(o, 'vestingDays', 'vesting_days')}d · disc ${field(o, 'discountBps', 'discount_bps')} · ${field(o, 'remaining')}/${field(o, 'totalOffered', 'total_offered')} left`,
                });
            }
        }
        offerFields.push({
            label: 'Total sold',
            value: `${field(offerList, 'totalComplete', 'total_complete')} AFHO`,
        });
    }

    const metricsInfo = remaining.metrics;
    const metrics = metricsInfo
        ? (ammCoder.decode('MarketMetrics', Buffer.from(metricsInfo.data)) as Record<string, unknown> | null)
        : null;
    if (metrics) {
        const trail = field<number[]>(metrics, 'trailingStakeHealth', 'trailing_stake_health') ?? [];
        offerFields.push(
            { label: 'Metrics day', value: `${field(metrics, 'dayIndex', 'day_index')}` },
            {
                label: 'Staked / supply',
                value: `${fmtToken(field(metrics, 'totalStaked', 'total_staked'), decimals)} / ${fmtToken(field(metrics, 'totalSupply', 'total_supply'), decimals)}`,
            },
            { label: 'Stake trend (5d)', value: trail.join(' → ') || '—' },
        );
    }

    const acceptedInfo = remaining.acceptedOffers;
    if (acceptedInfo) {
        const hasDay = acceptedInfo.data.length >= 31;
        const base = hasDay ? 16 : 8;
        const read5 = (off: number) => Array.from(acceptedInfo.data.slice(base + off, base + off + 5));
        offerFields.push(
            { label: 'Last recorded day', value: hasDay ? `${u64At(acceptedInfo.data, 8)}` : 'legacy acct' },
            { label: 'Big accepted (5d)', value: read5(0).join(' → ') },
            { label: 'Med accepted (5d)', value: read5(5).join(' → ') },
            { label: 'Sml accepted (5d)', value: read5(10).join(' → ') },
        );
    } else {
        missing.push('accepted_offers PDA');
    }
    if (!metrics) missing.push('metrics PDA');

    // ---- AMM ----
    const ammFields: DashField[] = [];
    if (ammState) {
        ammFields.push(
            {
                label: 'SOL / USDC proceeds',
                value: `${fmtSol(field(ammState, 'totalSolProceeds', 'total_sol_proceeds'))} / ${fmtToken(field(ammState, 'totalUsdcProceeds', 'total_usdc_proceeds'), 6)} USDC`,
            },
            {
                label: 'Highest buyback basis',
                // Stored in floor units (price × 1e9 nano-USD per token):
                // 4505 = $0.000004505/AFHO. Display it as a dollar price.
                value: `$${(Number(field(ammState, 'highestBuybackBasis', 'highest_buyback_basis')) / 1e9).toFixed(9)}`,
            },
        );
    }
    const ammAfho = token(remaining.ammAfhoVault);
    const ammUsdc = token(remaining.ammUsdcVault);
    const ammSol = remaining.ammSolVault;
    const usdcDip = token(remaining.usdcDip);
    const solDip = remaining.solDip;
    if (ammAfho !== null) ammFields.push({ label: 'AFHO vault', value: fmtToken(ammAfho, decimals) });
    if (ammUsdc !== null) ammFields.push({ label: 'Buyback USDC vault', value: fmtToken(ammUsdc, 6) });
    if (ammSol) ammFields.push({ label: 'Buyback SOL vault', value: fmtSol(ammSol.lamports) });
    if (usdcDip !== null) ammFields.push({ label: 'Dip USDC vault', value: fmtToken(usdcDip, 6) });
    if (solDip) ammFields.push({ label: 'Dip SOL vault', value: fmtSol(solDip.lamports) });
    if (!ammState) missing.push('amm_state');

    // ---- Staking ----
    const stakeFields: DashField[] = [];
    if (pool) {
        stakeFields.push(
            { label: 'Total staked', value: fmtToken(field(pool, 'totalStaked', 'total_staked'), decimals) },
            {
                label: 'Weighted stake',
                value: fmtToken(field(pool, 'totalWeightedStake', 'total_weighted_stake'), decimals),
            },
        );
    }
    for (const [label, key] of [
        ['Stake vault', 'stakeVault'],
        ['Reward vault', 'rewardVault'],
        ['Penalty vault', 'penaltyVault'],
        ['POSR vault', 'posrVault'],
    ] as const) {
        const amount = token(remaining[key as keyof RemainingAccounts] as { data: Uint8Array } | null);
        if (amount !== null) stakeFields.push({ label, value: fmtToken(amount, decimals) });
    }
    if (!pool) missing.push('stake pool');

    // ---- Crank & bounty ----
    const status = marketStatus;
    const bountyCfgInfo = remaining.bountyConfig;
    const bountyCfg = bountyCfgInfo
        ? (crankCoder.decode('BountyConfig', Buffer.from(bountyCfgInfo.data)) as Record<string, unknown> | null)
        : null;
    const bountyVaultInfo = remaining.bountyVault;
    const crankFields: DashField[] = [];
    if (status) {
        crankFields.push(
            { label: 'Market state (raw)', value: `${status.state}` },
            { label: 'Trading day', value: `${status.tradingDay}` },
            { label: 'Last update', value: fmtTs(status.timestamp) },
        );
    }
    if (bountyCfg) {
        crankFields.push({
            label: 'Bounty / crank',
            value: fmtSol(field(bountyCfg, 'bountyAmount', 'bounty_amount')),
        });
    }
    if (bountyVaultInfo) {
        crankFields.push({ label: 'Bounty vault', value: fmtSol(bountyVaultInfo.lamports) });
    }
    if (!status) missing.push('market_status');

    const [acceptedOffersPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('accepted_offers'), deployment.mintKey.toBuffer()],
        ammProgram,
    );
    const [metricsPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('metrics'), deployment.mintKey.toBuffer()],
        ammProgram,
    );
    const [bountyConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('bounty_config')],
        crankProgram,
    );
    const [bountyVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('bounty_vault')],
        crankProgram,
    );

    const addr = (label: string, value?: string): DashField => ({
        label,
        value: value ?? 'not configured',
    });

    const [usdcDipPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('amm_usdc_dip'), deployment.mintKey.toBuffer()],
        ammProgram,
    );
    const [solDipPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('amm_sol_dip'), deployment.mintKey.toBuffer()],
        ammProgram,
    );

    const sections: DashSection[] = [
        {
            title: 'Offer Sheet',
            initialized: !!offerList,
            fields: offerFields,
            addresses: [
                addr('OfferList', deployment.ammOfferList),
                addr('AcceptedOffers', acceptedOffersPda.toBase58()),
                addr('Metrics', metricsPda.toBase58()),
            ],
        },
        {
            title: 'After-Hours AMM',
            initialized: !!ammState,
            fields: ammFields,
            addresses: [
                addr('AmmState', deployment.ammState),
                addr('AFHO vault', deployment.ammAfhoVault),
                addr('Buyback USDC vault', deployment.ammUsdcVault),
                addr('Buyback SOL vault', deployment.ammSolVault),
                addr('Dip USDC vault', usdcDipPda.toBase58()),
                addr('Dip SOL vault', solDipPda.toBase58()),
            ],
        },
        {
            title: 'Staking Pool',
            initialized: !!pool,
            fields: stakeFields,
            addresses: [
                addr('Pool', deployment.pool),
                addr('Stake vault', deployment.vault),
                addr('Reward vault', deployment.rewardVault),
                addr('Penalty vault', deployment.penaltyVault),
                addr('POSR vault', deployment.posrVault),
            ],
        },
        {
            title: 'Crank Oracle & Bounty',
            initialized: !!status && status.state !== 99,
            fields: crankFields,
            addresses: [
                addr('MarketStatus', deployment.marketStatus),
                addr('BountyConfig', bountyConfigPda.toBase58()),
                addr('BountyVault', bountyVaultPda.toBase58()),
            ],
        },
        {
            title: 'Mint & Launch',
            initialized: !!mintInfo,
            fields: [
                { label: 'Supply', value: fmtToken(mintSupply, decimals) },
                { label: 'Decimals', value: `${decimals}` },
                { label: 'Mint authority', value: mintAuthRenounced ? 'renounced' : 'active' },
            ],
            addresses: [
                { label: 'Mint', value: deployment.mint ?? 'not configured' },
                { label: 'Coin program', value: deployment.coinMintProgram ?? 'not configured' },
            ],
        },
    ];

    return { sections, missing, updatedAt: new Date().toISOString() };
}

export function useDashData() {
    const { connection } = useConnection();
    const { deployment, marketStatus, pool, ammState, offerList, refresh } = useChainData();

    const programs = useMemo(() => {
        return {
            ammProgram: deployment?.ammProgram
                ? new PublicKey(deployment.ammProgram)
                : AMM_PROGRAM_ID,
            crankProgram: deployment?.crankProgram
                ? new PublicKey(deployment.crankProgram)
                : CRANK_PROGRAM_ID,
        };
    }, [deployment]);
    const { ammProgram, crankProgram } = programs;

    const remainingQuery = useQuery({
        queryKey: ['dashRemaining', deployment?.mintKey.toBase58() ?? ''],
        queryFn: async () => {
            if (!deployment) throw new Error('Deployment not loaded');
            return fetchRemainingAccounts(connection, deployment, ammProgram, crankProgram);
        },
        enabled: !!deployment,
        staleTime: 15000,
        refetchInterval: typeof document !== 'undefined' && !document.hidden ? 15000 : false,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
            const msg = error instanceof Error ? error.message : String(error);
            return /429|rate/i.test(msg) ? failureCount < 3 : failureCount < 1;
        },
        retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    });

    const doRefresh = useCallback(() => {
        void refresh('amm');
        void refresh('marketStatus');
        void refresh('pool');
    }, [refresh]);

    const data = useMemo(() => {
        if (!deployment || !remainingQuery.data) return null;
        return buildDashData(
            deployment,
            marketStatus,
            pool,
            ammState,
            offerList,
            remainingQuery.data,
            ammProgram,
            crankProgram,
        );
    }, [deployment, marketStatus, pool, ammState, offerList, remainingQuery.data, ammProgram, crankProgram]);

    const error = remainingQuery.error instanceof Error ? remainingQuery.error.message : null;

    return { data, error, refresh: doRefresh };
}
