import { useEffect, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { Connection, PublicKey } from '@solana/web3.js';
import { BorshAccountsCoder, type Idl } from '@coral-xyz/anchor';
import stakingIdl from '../../../target/idl/staking.json';
import crankIdl from '../../../target/idl/crank_oracle.json';
import ammIdl from '../../../target/idl/amm.json';
import type { DeploymentConfig } from '../config';

// deployment.json carries more than the app's DeploymentConfig type
type DashConfig = DeploymentConfig & {
    ammProgram?: string;
    ammState?: string;
    ammOfferList?: string;
    ammSolVault?: string;
    ammUsdcVault?: string;
    ammAfhoVault?: string;
};

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

function idlProgramId(idl: unknown): PublicKey {
    const meta = idl as { metadata?: { address?: string }; address?: string };
    const address = meta.metadata?.address ?? meta.address;
    if (!address) throw new Error('IDL missing program address');
    return new PublicKey(address);
}

const AMM_PROGRAM_ID = idlProgramId(ammIdl);
const CRANK_PROGRAM_ID = idlProgramId(crankIdl);

const stakingCoder = new BorshAccountsCoder(stakingIdl as Idl);
const crankCoder = new BorshAccountsCoder(crankIdl as Idl);
const ammCoder = new BorshAccountsCoder(ammIdl as Idl);

function pk(value?: string): PublicKey | null {
    if (!value) return null;
    try {
        return new PublicKey(value);
    } catch {
        return null;
    }
}

function u64At(data: Uint8Array, offset: number): bigint {
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);
}

function u32At(data: Uint8Array, offset: number): number {
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

// SPL token account: amount u64 @ offset 64
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

type DecodedAccount = Record<string, unknown>;

function decode(coder: BorshAccountsCoder, name: string, data: Uint8Array): DecodedAccount | null {
    try {
        return coder.decode(name, Buffer.from(data)) as DecodedAccount;
    } catch {
        return null;
    }
}

// Anchor 0.31 IDL coders return camelCase; handle snake_case too for safety.
function field<T>(obj: DecodedAccount, ...names: string[]): T | undefined {
    for (const n of names) {
        if (obj[n] !== undefined && obj[n] !== null) return obj[n] as T;
    }
    return undefined;
}

async function fetchConfig(): Promise<DashConfig> {
    const res = await fetch(`/deployment.json?t=${Date.now()}`, { cache: 'no-store' });
    return res.ok ? await res.json() : {};
}

export function useDashData() {
    const { connection } = useConnection();
    const [data, setData] = useState<DashData | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        async function load() {
            try {
                const config = await fetchConfig();
                const dash = await buildDashData(connection, config);
                if (!cancelled) {
                    setData(dash);
                    setError(null);
                }
            } catch (err) {
                if (!cancelled) setError(err instanceof Error ? err.message : 'RPC fetch failed');
            }
        }

        load();
        const timer = setInterval(load, 30_000);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [connection]);

    return { data, error };
}

async function buildDashData(
    connection: Connection,
    config: DashConfig,
): Promise<DashData> {
    const missing: string[] = [];

    const mint = pk(config.mint);
    const ammProgram = pk(config.ammProgram) ?? AMM_PROGRAM_ID;
    const crankProgram = pk(config.crankProgram) ?? CRANK_PROGRAM_ID;

    // PDAs not stored in deployment.json — derive from seeds
    const [acceptedOffersPda] = mint
        ? PublicKey.findProgramAddressSync([Buffer.from('accepted_offers'), mint.toBuffer()], ammProgram)
        : [null];
    const [metricsPda] = mint
        ? PublicKey.findProgramAddressSync([Buffer.from('metrics'), mint.toBuffer()], ammProgram)
        : [null];
    const [bountyConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('bounty_config')],
        crankProgram,
    );
    const [bountyVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('bounty_vault')],
        crankProgram,
    );

    const keys: Record<string, PublicKey | null> = {
        mint,
        pool: pk(config.pool),
        stakeVault: pk(config.vault),
        rewardVault: pk(config.rewardVault),
        penaltyVault: pk(config.penaltyVault),
        posrVault: pk(config.posrVault),
        marketStatus: pk(config.marketStatus),
        bountyConfig: bountyConfigPda,
        bountyVault: bountyVaultPda,
        ammState: pk(config.ammState),
        offerList: pk(config.ammOfferList),
        acceptedOffers: acceptedOffersPda,
        metrics: metricsPda,
        ammAfhoVault: pk(config.ammAfhoVault),
        ammUsdcVault: pk(config.ammUsdcVault),
        ammSolVault: pk(config.ammSolVault),
    };

    const names = Object.keys(keys);
    const infos = await connection.getMultipleAccountsInfo(
        names.map((n) => keys[n] ?? PublicKey.default),
    );
    const account = (name: string) => (keys[name] ? infos[names.indexOf(name)] : null);

    // ---- Mint (needed for decimals everywhere else) ----
    const mintInfo = account('mint');
    let decimals = 9;
    let mintSupply = 0n;
    let mintAuthRenounced = false;
    if (mintInfo && mintInfo.data.length >= 82) {
        mintSupply = u64At(mintInfo.data, 36);
        decimals = mintInfo.data[44];
        mintAuthRenounced = u32At(mintInfo.data, 0) === 0;
    }
    if (!mintInfo) missing.push('mint');

    const token = (name: string): bigint | null => {
        const info = account(name);
        return info && info.data.length >= 72 ? tokenAmount(info.data) : null;
    };

    // ---- Offer sheet ----
    const offerListInfo = account('offerList');
    const offerList = offerListInfo ? decode(ammCoder, 'OfferList', offerListInfo.data) : null;
    const metricsInfo = account('metrics');
    const metrics = metricsInfo ? decode(ammCoder, 'MarketMetrics', metricsInfo.data) : null;
    const acceptedInfo = account('acceptedOffers');

    const offerFields: DashField[] = [];
    if (offerList) {
        for (const [label, key] of [
            ['Big', 'big'],
            ['Med', 'med'],
            ['Sml', 'sml'],
        ] as const) {
            const o = field<DecodedAccount>(offerList, `${key}Offer`, `${key}_offer`);
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
    if (acceptedInfo) {
        // Legacy layout (no day_index): 8 disc + 15 bytes. Current: +8 byte day_index.
        const hasDay = acceptedInfo.data.length >= 31;
        const base = hasDay ? 16 : 8;
        const read5 = (off: number) => Array.from(acceptedInfo.data.slice(base + off, base + off + 5));
        offerFields.push(
            {
                label: 'Last recorded day',
                value: hasDay ? `${u64At(acceptedInfo.data, 8)}` : 'legacy acct',
            },
            { label: 'Big accepted (5d)', value: read5(0).join(' → ') },
            { label: 'Med accepted (5d)', value: read5(5).join(' → ') },
            { label: 'Sml accepted (5d)', value: read5(10).join(' → ') },
        );
    } else {
        missing.push('accepted_offers PDA');
    }
    if (!metrics) missing.push('metrics PDA');

    // ---- AMM ----
    const ammStateInfo = account('ammState');
    const ammState = ammStateInfo ? decode(ammCoder, 'AmmState', ammStateInfo.data) : null;
    const ammFields: DashField[] = [];
    if (ammState) {
        ammFields.push(
            {
                label: 'SOL / USDC proceeds',
                value: `${fmtSol(field(ammState, 'totalSolProceeds', 'total_sol_proceeds'))} / ${fmtToken(field(ammState, 'totalUsdcProceeds', 'total_usdc_proceeds'), 6)} USDC`,
            },
            {
                label: 'Highest buyback basis',
                value: `${field(ammState, 'highestBuybackBasis', 'highest_buyback_basis')}`,
            },
        );
    }
    const ammAfho = token('ammAfhoVault');
    const ammUsdc = token('ammUsdcVault');
    const ammSol = account('ammSolVault');
    if (ammAfho !== null) ammFields.push({ label: 'AFHO vault', value: fmtToken(ammAfho, decimals) });
    if (ammUsdc !== null) ammFields.push({ label: 'USDC vault', value: fmtToken(ammUsdc, 6) });
    if (ammSol) ammFields.push({ label: 'SOL vault', value: fmtSol(ammSol.lamports) });
    if (!ammState) missing.push('amm_state');

    // ---- Staking ----
    const poolInfo = account('pool');
    const pool = poolInfo ? decode(stakingCoder, 'StakePool', poolInfo.data) : null;
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
        const amount = token(key);
        if (amount !== null) stakeFields.push({ label, value: fmtToken(amount, decimals) });
    }
    if (!pool) missing.push('stake pool');

    // ---- Crank & bounty ----
    const statusInfo = account('marketStatus');
    const status = statusInfo ? decode(crankCoder, 'MarketStatus', statusInfo.data) : null;
    const bountyCfgInfo = account('bountyConfig');
    const bountyCfg = bountyCfgInfo ? decode(crankCoder, 'BountyConfig', bountyCfgInfo.data) : null;
    const bountyVaultInfo = account('bountyVault');
    const crankFields: DashField[] = [];
    if (status) {
        crankFields.push(
            { label: 'Market state (raw)', value: `${field(status, 'currentState', 'current_state')}` },
            { label: 'Trading day', value: `${field(status, 'tradingDayIndex', 'trading_day_index')}` },
            {
                label: 'Last update',
                value: fmtTs(field(status, 'lastUpdatedTimestamp', 'last_updated_timestamp')),
            },
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

    // ---- Assemble, top (latest launch stage) → bottom (first) ----
    const addr = (label: string, key: string): DashField => ({
        label,
        value: keys[key]?.toBase58() ?? 'not configured',
    });

    const sections: DashSection[] = [
        {
            title: 'Offer Sheet',
            initialized: !!offerList,
            fields: offerFields,
            addresses: [
                addr('OfferList', 'offerList'),
                addr('AcceptedOffers', 'acceptedOffers'),
                addr('Metrics', 'metrics'),
            ],
        },
        {
            title: 'After-Hours AMM',
            initialized: !!ammState,
            fields: ammFields,
            addresses: [
                addr('AmmState', 'ammState'),
                addr('AFHO vault', 'ammAfhoVault'),
                addr('USDC vault', 'ammUsdcVault'),
                addr('SOL vault', 'ammSolVault'),
            ],
        },
        {
            title: 'Staking Pool',
            initialized: !!pool,
            fields: stakeFields,
            addresses: [
                addr('Pool', 'pool'),
                addr('Stake vault', 'stakeVault'),
                addr('Reward vault', 'rewardVault'),
                addr('Penalty vault', 'penaltyVault'),
                addr('POSR vault', 'posrVault'),
            ],
        },
        {
            title: 'Crank Oracle & Bounty',
            initialized: !!status && (status.currentState ?? status.current_state) !== 99,
            fields: crankFields,
            addresses: [
                addr('MarketStatus', 'marketStatus'),
                addr('BountyConfig', 'bountyConfig'),
                addr('BountyVault', 'bountyVault'),
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
                { label: 'Mint', value: config.mint ?? 'not configured' },
                { label: 'Coin program', value: config.coinMintProgram ?? 'not configured' },
            ],
        },
    ];

    return { sections, missing, updatedAt: new Date().toISOString() };
}