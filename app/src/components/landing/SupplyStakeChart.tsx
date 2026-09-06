import { useEffect, useMemo, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { usePoolStats } from '../../hooks/usePoolStats';
import { useChainData } from '../../context/useChainData';
import './SupplyChart.css';

/* SupplyStakeChart — two lines, two shaded regions under them.
 *
 *   • AVAILABLE — released supply: total supply − bond-desk inventory
 *     (amm afho_vault). Starts at the 250M launch release (1B minted −
 *     750M desk seed) and rises as the desk releases supply out of the
 *     protocol lock. Bond-desk volume itself is NOT charted.
 *   • LOCKED — staked AFHO (staking pool total_staked). Starts at zero,
 *     rises when people stake (bond vesting positions stake automatically,
 *     so releases flow in here too) and falls when people unstake.
 *
 * Both series are real on-chain quantities — nothing modeled. There is no
 * on-chain time series, so one sample per calendar day (ET, the protocol's
 * day boundary) is recorded to localStorage; the series is anchored at the
 * launch point (250M available / 0 locked). Keep GENESIS_AVAILABLE in sync
 * with AFHO_TO_LP in scripts/mint-launch.ts. */

const STORAGE_KEY = 'afho-supply-history-v2';
const MAX_DAYS = 120;
const GENESIS_AVAILABLE = 250_000_000;

type Sample = {
    day: string; // YYYY-MM-DD (ET) — one sample per day, latest wins
    t: number; // ms epoch of the sample
    available: number; // total supply − bond-desk inventory
    locked: number; // staked AFHO
};

/* Current date in US Eastern time (the protocol's day boundary), YYYY-MM-DD. */
function etDayString(d = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

function dayBefore(day: string): string {
    const [y, m, d] = day.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - 1);
    return dt.toISOString().slice(0, 10);
}

function loadSamples(): Sample[] {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const cleaned: Sample[] = [];
        for (const s of parsed as unknown[]) {
            const v = s as Sample;
            if (
                typeof v?.day === 'string' &&
                typeof v?.t === 'number' &&
                Number.isFinite(v?.available) &&
                Number.isFinite(v?.locked) &&
                v.available >= 0 &&
                v.locked >= 0
            ) {
                cleaned.push(v);
            }
        }
        return cleaned;
    } catch {
        return [];
    }
}

function persist(samples: Sample[]) {
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(samples.slice(-MAX_DAYS)));
    } catch {
        /* private mode / quota — the chart just won't keep history */
    }
}

async function fetchTokenUiAmount(
    connection: ReturnType<typeof useConnection>['connection'],
    account: PublicKey,
): Promise<number | null> {
    try {
        const info = await connection.getTokenAccountBalance(account, 'confirmed');
        return info.value.uiAmount ?? null;
    } catch {
        return null;
    }
}

const fmtTokens = (n: number) =>
    n >= 1e6
        ? `${(n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 0 })}M`
        : n.toLocaleString('en-US', { maximumFractionDigits: 0 });

const W = 560; // viewBox units
const H = 220;
const PAD_L = 52;
const PAD_R = 14;
const PAD_T = 14;
const PAD_B = 26;

export function SupplyStakeChart() {
    const { stats, loading } = usePoolStats();
    const { ammState } = useChainData();
    const { connection } = useConnection();
    const [history, setHistory] = useState<Sample[]>([]);
    const [deskVault, setDeskVault] = useState<number | null>(null);

    useEffect(() => {
        const samples = loadSamples();
        if (samples.length) setHistory(samples);
    }, []);

    // Bond-desk inventory (amm afho_vault) — the protocol lock. A light poll
    // keeps the right edge current between react-query refreshes.
    const vaultKey = ammState?.afhoVault ?? ammState?.afho_vault ?? null;
    useEffect(() => {
        if (!vaultKey) return;
        let cancelled = false;
        const vault = new PublicKey(vaultKey);
        fetchTokenUiAmount(connection, vault).then((v) => {
            if (!cancelled && v !== null) setDeskVault(v);
        });
        const id = window.setInterval(() => {
            fetchTokenUiAmount(connection, vault).then((v) => {
                if (!cancelled && v !== null) setDeskVault(v);
            });
        }, 60_000);
        return () => {
            cancelled = true;
            window.clearInterval(id);
        };
    }, [vaultKey, connection]);

    const available = stats && deskVault !== null ? Math.max(0, stats.totalSupply - deskVault) : null;
    const locked = stats?.totalStaked ?? null;

    // Record today's sample (latest write wins per ET day) once both series
    // values are known; re-record only on a material move.
    useEffect(() => {
        if (available === null || locked === null || !stats || stats.totalSupply <= 0) return;
        setHistory((prev) => {
            const day = etDayString();
            const next: Sample = { day, t: Date.now(), available, locked };
            const last = prev[prev.length - 1];
            if (last && last.day === day) {
                const moved =
                    Math.abs(last.available - available) > Math.max(1, last.available * 0.005) ||
                    Math.abs(last.locked - locked) > Math.max(1, last.locked * 0.005);
                if (!moved) return prev;
                return [...prev.slice(0, -1), next];
            }
            return [...prev, next].slice(-MAX_DAYS);
        });
    }, [stats, available, locked]);

    useEffect(() => {
        if (history.length) persist(history);
    }, [history]);

    const { pathAvailable, pathLocked, areaAvailable, areaLocked, yTicks, xLabels, pctLabel, live } = useMemo(() => {
        if (available === null || locked === null) {
            return { pathAvailable: '', pathLocked: '', areaAvailable: '', areaLocked: '', yTicks: [], xLabels: [], pctLabel: null, live: null };
        }
        const live: Sample = { day: etDayString(), t: Date.now(), available, locked };
        const recorded = [...history];
        // Anchor the series at the launch release: 250M available, nothing
        // staked, dated one day before the oldest recorded sample.
        const oldest = recorded[0];
        const genesis: Sample = {
            day: dayBefore(oldest ? oldest.day : live.day),
            t: oldest ? oldest.t - 86_400_000 : live.t - 86_400_000,
            available: GENESIS_AVAILABLE,
            locked: 0,
        };
        const pts: Sample[] = [genesis, ...recorded];
        if (pts.length === 1 || pts[pts.length - 1].day !== live.day) pts.push(live);
        else pts[pts.length - 1] = live;

        // Simple shared axis: 0 at the baseline (so the locked line starts
        // AT zero and is always visible) up to just above the highest value.
        const yMax = Math.max(1, ...pts.map((p) => Math.max(p.available, p.locked))) * 1.06;
        const x = (i: number) =>
            PAD_L + (pts.length <= 1 ? 0 : (i / (pts.length - 1)) * (W - PAD_L - PAD_R));
        const y = (v: number) => PAD_T + (1 - v / yMax) * (H - PAD_T - PAD_B);

        const pathAvailable = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.available).toFixed(1)}`).join(' ');
        const pathLocked = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.locked).toFixed(1)}`).join(' ');

        // One shaded region under each line, both filling to the baseline.
        const base = y(0).toFixed(1);
        const areaAvailable =
            pts.length > 1
                ? `${pathAvailable} L${x(pts.length - 1).toFixed(1)},${base} L${x(0).toFixed(1)},${base} Z`
                : '';
        const areaLocked =
            pts.length > 1
                ? `${pathLocked} L${x(pts.length - 1).toFixed(1)},${base} L${x(0).toFixed(1)},${base} Z`
                : '';

        const ticks = [0, yMax / 2, yMax].map((v) => ({
            y: y(v),
            label: v === 0 ? '0' : fmtTokens(v),
        }));
        const labels =
            pts.length > 1
                ? [
                      { x: x(0), label: pts[0].day.slice(5) },
                      { x: x(pts.length - 1), label: pts[pts.length - 1].day.slice(5) },
                  ]
                : [];

        const pct =
            stats && stats.totalSupply > 0
                ? `${((locked / stats.totalSupply) * 100).toFixed(1)}% of supply staked`
                : null;

        return { pathAvailable, pathLocked, areaAvailable, areaLocked, yTicks: ticks, xLabels: labels, pctLabel: pct, live };
    }, [history, stats, available, locked]);

    if (loading || available === null || locked === null || !live) {
        return <div className="supply-chart loading">Loading supply chart…</div>;
    }

    return (
        <div className="supply-chart glass-pane neon-shadow shadow-wander-a">
            <header className="supply-chart-head">
                <h3 className="supply-chart-title">Released supply &amp; staked supply</h3>
                <p className="supply-chart-sub">
                    available = total supply − bond-desk inventory · locked = staked · one point per trading day (ET)
                </p>
            </header>
            <svg
                className="supply-chart-svg"
                viewBox={`0 0 ${W} ${H}`}
                role="img"
                aria-label={`Released supply over time: ${fmtTokens(live.available)} AFHO available (launch release ${fmtTokens(GENESIS_AVAILABLE)}), ${fmtTokens(locked)} locked in staking${pctLabel ? ` — ${pctLabel}` : ''}.`}
            >
                {yTicks.map((t, i) => (
                    <g key={i}>
                        <line className="supply-chart-gridline" x1={PAD_L} x2={W - PAD_R} y1={t.y} y2={t.y} />
                        <text className="supply-chart-ytick" x={PAD_L - 6} y={t.y + 3} textAnchor="end">
                            {t.label}
                        </text>
                    </g>
                ))}

                {/* shaded region under the available line (bottom layer) */}
                {areaAvailable && <path className="supply-chart-area-available" d={areaAvailable} />}
                {/* shaded region under the locked line (drawn over it) */}
                {areaLocked && <path className="supply-chart-area-locked" d={areaLocked} />}

                {/* the two lines */}
                <path className="supply-chart-line" d={pathAvailable} />
                <path className="supply-chart-line-locked" d={pathLocked} />

                {xLabels.map((l, i) => (
                    <text key={i} className="supply-chart-xtick" x={l.x} y={H - 8} textAnchor={i === 0 ? 'start' : 'end'}>
                        {l.label}
                    </text>
                ))}
            </svg>
            <div className="supply-chart-legend">
                <span className="supply-chart-key">
                    <i className="supply-chart-swatch swatch-available" /> Available {fmtTokens(live.available)}
                </span>
                <span className="supply-chart-key">
                    <i className="supply-chart-swatch swatch-staked" /> Locked — staked {fmtTokens(locked)}
                    {pctLabel ? ` (${pctLabel})` : ''}
                </span>
            </div>
        </div>
    );
}
