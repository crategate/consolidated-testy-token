import { useEffect, useMemo, useRef, useState } from 'react';
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
 * on-chain time series, so points are recorded to localStorage (capped at
 * MAX_POINTS): one per trading day — keyed by the on-chain trading_day_index
 * exactly like the records ledger, with same-date points both kept — and the
 * launch point (250M available / 0 locked). Keep GENESIS_AVAILABLE in sync
 * with AFHO_TO_LP in scripts/mint-launch.ts. */

const STORAGE_KEY = 'afho-supply-history-v3';
const MAX_POINTS = 400;
const GENESIS_AVAILABLE = 250_000_000;

type Sample = {
    day: string; // YYYY-MM-DD (ET) — the calendar date the sample was taken
    tday: number | null; // on-chain trading_day_index (null = unknown)
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
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(samples.slice(-MAX_POINTS)));
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

const fmtExact = (n: number) => Math.round(n).toLocaleString('en-US');

const fmtDelta = (d: number) => `${d >= 0 ? '+' : '−'}${fmtTokens(Math.abs(d))}`;

function fmtDayLabel(day: string): string {
    const [y, m, d] = day.split('-').map(Number);
    return new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    }).format(new Date(Date.UTC(y, m - 1, d)));
}

const W = 560; // viewBox units
const H = 220;
const PAD_L = 52;
const PAD_R = 14;
const PAD_T = 14;
const PAD_B = 26;

export function SupplyStakeChart() {
    const { stats, loading } = usePoolStats();
    const { ammState, marketStatus } = useChainData();
    const { connection } = useConnection();
    const [history, setHistory] = useState<Sample[]>([]);
    const [deskVault, setDeskVault] = useState<number | null>(null);
    const svgRef = useRef<SVGSVGElement | null>(null);
    const [hover, setHover] = useState<{ i: number; yv: number } | null>(null);

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

    // Record one point per TRADING DAY, keyed by the on-chain day index the
    // same way the records ledger is. A point is appended when the trading
    // day rolls OR values move materially — so two points can share a
    // calendar date (both plotted) and the stairstep stays visible.
    const tday = marketStatus?.tradingDay ?? null;
    useEffect(() => {
        if (available === null || locked === null || !stats || stats.totalSupply <= 0) return;
        setHistory((prev) => {
            const last = prev[prev.length - 1];
            const next: Sample = { day: etDayString(), tday, t: Date.now(), available, locked };
            if (!last) return [next];
            const dayRolled = tday !== null && last.tday !== null && tday !== last.tday;
            const moved =
                Math.abs(last.available - available) > Math.max(1, last.available * 0.005) ||
                Math.abs(last.locked - locked) > Math.max(1, last.locked * 0.005);
            if (dayRolled || moved) return [...prev, next].slice(-MAX_POINTS);
            return prev;
        });
    }, [stats, available, locked, tday]);

    useEffect(() => {
        if (history.length) persist(history);
    }, [history]);

    const {
        pathAvailable,
        pathLocked,
        areaAvailable,
        areaLocked,
        yTicks,
        xLabels,
        pctLabel,
        series,
        xs,
        ysAvail,
        ysLocked,
    } = useMemo(() => {
        if (available === null || locked === null) {
            return {
                pathAvailable: '',
                pathLocked: '',
                areaAvailable: '',
                areaLocked: '',
                yTicks: [],
                xLabels: [],
                pctLabel: null,
                series: [] as Sample[],
                xs: [] as number[],
                ysAvail: [] as number[],
                ysLocked: [] as number[],
            };
        }
        const live: Sample = { day: etDayString(), tday, t: Date.now(), available, locked };
        const recorded = [...history];
        // Anchor the series at the launch release: 250M available, nothing
        // staked, dated one day before the oldest recorded sample.
        const oldest = recorded[0];
        const genesis: Sample = {
            day: dayBefore(oldest ? oldest.day : live.day),
            tday: null,
            t: oldest ? oldest.t - 86_400_000 : live.t - 86_400_000,
            available: GENESIS_AVAILABLE,
            locked: 0,
        };
        const pts: Sample[] = [genesis, ...recorded];
        if (pts.length === 1 || pts[pts.length - 1].tday !== live.tday) pts.push(live);
        else pts[pts.length - 1] = live;

        // Simple shared axis: 0 at the baseline (so the locked line starts
        // AT zero and is always visible) up to just above the highest value.
        const yMax = Math.max(1, ...pts.map((p) => Math.max(p.available, p.locked))) * 1.06;
        const x = (i: number) =>
            PAD_L + (pts.length <= 1 ? 0 : (i / (pts.length - 1)) * (W - PAD_L - PAD_R));
        const y = (v: number) => PAD_T + (1 - v / yMax) * (H - PAD_T - PAD_B);

        const xs = pts.map((_, i) => x(i));
        const ysAvail = pts.map((p) => y(p.available));
        const ysLocked = pts.map((p) => y(p.locked));

        // Step-after rendering: each value HOLDS until the next recorded
        // point, so day-boundary releases and stake changes read as stairsteps.
        const stepPath = (ys: number[]) => {
            if (ys.length === 0) return '';
            let d = `M${xs[0].toFixed(1)},${ys[0].toFixed(1)}`;
            for (let i = 1; i < ys.length; i++) {
                d += ` H${xs[i].toFixed(1)} V${ys[i].toFixed(1)}`;
            }
            return d;
        };
        const pathAvailable = stepPath(ysAvail);
        const pathLocked = stepPath(ysLocked);

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

        return { pathAvailable, pathLocked, areaAvailable, areaLocked, yTicks: ticks, xLabels: labels, pctLabel: pct, series: pts, xs, ysAvail, ysLocked };
    }, [history, stats, available, locked]);

    /* ── hover: snap to the nearest recorded day ── */
    const snapToNearest = (clientX: number, clientY: number) => {
        const svg = svgRef.current;
        if (!svg || xs.length === 0) return;
        const rect = svg.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const xv = ((clientX - rect.left) / rect.width) * W;
        const yv = ((clientY - rect.top) / rect.height) * H;
        let best = 0;
        let bestD = Infinity;
        for (let i = 0; i < xs.length; i++) {
            const d = Math.abs(xs[i] - xv);
            if (d < bestD) {
                bestD = d;
                best = i;
            }
        }
        setHover((prev) => (prev && prev.i === best ? { i: best, yv } : { i: best, yv }));
    };

    const onKeyDown = (e: React.KeyboardEvent<SVGSVGElement>) => {
        if (xs.length === 0) return;
        if (e.key === 'Escape') {
            setHover(null);
            return;
        }
        let next: number | null = null;
        if (e.key === 'ArrowLeft') next = hover ? Math.max(0, hover.i - 1) : xs.length - 1;
        else if (e.key === 'ArrowRight') next = hover ? Math.min(xs.length - 1, hover.i + 1) : xs.length - 1;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = xs.length - 1;
        if (next !== null) {
            e.preventDefault();
            setHover({ i: next, yv: ysAvail[next] ?? 0 });
        }
    };

    if (loading || available === null || locked === null || series.length === 0) {
        return <div className="supply-chart loading">Loading supply chart…</div>;
    }

    const h = hover && hover.i < xs.length ? hover : null;
    const hovered = h ? series[h.i] : null;
    const prevHovered = h && h.i > 0 ? series[h.i - 1] : null;
    const dAvail = hovered && prevHovered ? hovered.available - prevHovered.available : null;
    const dLocked = hovered && prevHovered ? hovered.locked - prevHovered.locked : null;
    const hoverPct =
        hovered && stats && stats.totalSupply > 0
            ? `${((hovered.locked / stats.totalSupply) * 100).toFixed(1)}%`
            : null;
    // Popover anchor: clamp inside the plot on both axes so it never overflows.
    const tipLeft = h ? Math.min(84, Math.max(16, (xs[h.i] / W) * 100)) : 50;
    const tipTop = h ? Math.min(72, Math.max(14, (h.yv / H) * 100)) : 40;

    return (
        <div className="supply-chart glass-pane neon-shadow shadow-wander-a">
            <header className="supply-chart-head">
                <h3 className="supply-chart-title">Released supply &amp; staked supply</h3>
                <p className="supply-chart-sub">
                    available = total supply − bond-desk inventory · locked = staked · one point per trading day (same-date points both plot)
                </p>
            </header>
            <div className="supply-chart-plot">
                <svg
                    ref={svgRef}
                    className="supply-chart-svg"
                    viewBox={`0 0 ${W} ${H}`}
                    role="img"
                    tabIndex={0}
                    aria-label={`Released supply and staked supply over time. Use left and right arrow keys to inspect each day. Latest: ${fmtTokens(available)} available, ${fmtTokens(locked)} locked${pctLabel ? ` — ${pctLabel}` : ''}.`}
                    onPointerMove={(e) => snapToNearest(e.clientX, e.clientY)}
                    onPointerDown={(e) => snapToNearest(e.clientX, e.clientY)}
                    onPointerLeave={() => setHover(null)}
                    onKeyDown={onKeyDown}
                    onBlur={() => setHover(null)}
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

                {/* hover crosshair + highlight dots */}
                {h && (
                    <g aria-hidden="true">
                        <line
                            className="supply-chart-crosshair"
                            x1={xs[h.i]}
                            x2={xs[h.i]}
                            y1={PAD_T}
                            y2={H - PAD_B}
                        />
                        <circle className="supply-chart-dot" cx={xs[h.i]} cy={ysAvail[h.i]} r={3.2} />
                        <circle className="supply-chart-dot-locked" cx={xs[h.i]} cy={ysLocked[h.i]} r={3.2} />
                    </g>
                )}

                {xLabels.map((l, i) => (
                    <text key={i} className="supply-chart-xtick" x={l.x} y={H - 8} textAnchor={i === 0 ? 'start' : 'end'}>
                        {l.label}
                    </text>
                ))}
                </svg>

                {/* day popover — anchored at the crosshair, clamped inside the plot */}
                {h && hovered && (
                    <div className="supply-chart-tooltip" role="status" style={{ left: `${tipLeft}%`, top: `${tipTop}%` }}>
                        <div className="supply-chart-tooltip-date">
                            {h.i === 0
                                ? 'Launch'
                                : `${hovered.tday !== null ? `Day #${hovered.tday} · ` : ''}${fmtDayLabel(hovered.day)}`}
                        </div>
                        <div className="supply-chart-tooltip-row">
                            <span className="tt-label">
                                <i className="supply-chart-swatch swatch-available" /> Available
                            </span>
                            <span className="tt-value">
                                {fmtExact(hovered.available)}
                                {dAvail !== null && <em className={dAvail >= 0 ? 'tt-up' : 'tt-down'}> {fmtDelta(dAvail)}</em>}
                            </span>
                        </div>
                        <div className="supply-chart-tooltip-row">
                            <span className="tt-label">
                                <i className="supply-chart-swatch swatch-staked" /> Locked
                            </span>
                            <span className="tt-value">
                                {fmtExact(hovered.locked)}
                                {hoverPct && <em className="tt-pct"> · {hoverPct}</em>}
                                {dLocked !== null && (
                                    <em className={dLocked >= 0 ? 'tt-up' : 'tt-down'}> {fmtDelta(dLocked)}</em>
                                )}
                            </span>
                        </div>
                    </div>
                )}
            </div>
            <div className="supply-chart-legend">
                <span className="supply-chart-key">
                    <i className="supply-chart-swatch swatch-available" /> Available {fmtTokens(available)}
                </span>
                <span className="supply-chart-key">
                    <i className="supply-chart-swatch swatch-staked" /> Locked — staked {fmtTokens(locked)}
                    {pctLabel ? ` (${pctLabel})` : ''}
                </span>
            </div>
        </div>
    );
}
