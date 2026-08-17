import { useEffect, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { Connection, PublicKey } from '@solana/web3.js';
import { BorshAccountsCoder, type Idl } from '@coral-xyz/anchor';
import ammIdl from '../../../../target/idl/amm.json';
import type { DeploymentConfig } from '../../config';

/* ── helpers ── */
function idlProgramId(idl: unknown): PublicKey {
    const meta = idl as { metadata?: { address?: string }; address?: string };
    const address = meta.metadata?.address ?? meta.address;
    if (!address) throw new Error('IDL missing program address');
    return new PublicKey(address);
}

function pk(value?: string): PublicKey | null {
    if (!value) return null;
    try { return new PublicKey(value); } catch { return null; }
}

function decode(coder: BorshAccountsCoder, name: string, data: Uint8Array) {
    try { return coder.decode(name, Buffer.from(data)) as Record<string, unknown> | null; }
    catch { return null; }
}

function field<T>(obj: Record<string, unknown> | null, ...names: string[]): T | undefined {
    if (!obj) return undefined;
    for (const n of names) {
        if (obj[n] !== undefined && obj[n] !== null) return obj[n] as T;
    }
    return undefined;
}

async function fetchConfig(): Promise<DeploymentConfig> {
    const res = await fetch(`/deployment.json?t=${Date.now()}`, { cache: 'no-store' });
    return res.ok ? await res.json() : {};
}

/* ── types ── */
export interface OfferTier {
    lotSize: number;
    vestingDays: number;
    discountBps: number;
    remaining: number;
    totalOffered: number;
}

export interface AmmData {
    ammState: Record<string, unknown> | null;
    offerList: Record<string, unknown> | null;
    metrics: Record<string, unknown> | null;
    acceptedOffers: Record<string, unknown> | null;
    offersLive: boolean;
    loading: boolean;
    error: string | null;
    updatedAt: string | null;
}

const AMM_PROGRAM_ID = idlProgramId(ammIdl);
const ammCoder = new BorshAccountsCoder(ammIdl as Idl);

export function useAmmData(): AmmData {
    const { connection } = useConnection();
    const [data, setData] = useState<AmmData>({
        ammState: null,
        offerList: null,
        metrics: null,
        acceptedOffers: null,
        offersLive: false,
        loading: true,
        error: null,
        updatedAt: null,
    });

    useEffect(() => {
        let cancelled = false;

        async function load() {
            if (!connection) return;
            try {
                const config = await fetchConfig();
                const mint = pk(config.mint);
                if (!mint) throw new Error('Mint not configured in deployment.json');

                console.log(config.ammProgram);
                const ammProgram = pk(config.ammProgram) ?? AMM_PROGRAM_ID;

                const [ammStatePda] = PublicKey.findProgramAddressSync(
                    [Buffer.from('amm_state'), mint.toBuffer()], ammProgram
                );
                const [offerListPda] = PublicKey.findProgramAddressSync(
                    [Buffer.from('offer_list'), mint.toBuffer()], ammProgram
                );
                const [acceptedPda] = PublicKey.findProgramAddressSync(
                    [Buffer.from('accepted_offers'), mint.toBuffer()], ammProgram
                );
                const [metricsPda] = PublicKey.findProgramAddressSync(
                    [Buffer.from('metrics'), mint.toBuffer()], ammProgram
                );

                const infos = await connection.getMultipleAccountsInfo([
                    ammStatePda, offerListPda, acceptedPda, metricsPda
                ]);

                const ammState = infos[0] ? decode(ammCoder, 'AmmState', infos[0].data) : null;
                const offerList = infos[1] ? decode(ammCoder, 'OfferList', infos[1].data) : null;
                const accepted = infos[2] ? decode(ammCoder, 'AcceptedOffers', infos[2].data) : null;
                const metrics = infos[3] ? decode(ammCoder, 'MarketMetrics', infos[3].data) : null;

                // ── offers live? any tier with remaining > 0 ──
                let offersLive = false;
                if (offerList) {
                    for (const tierKey of ['bigOffer', 'big_offer', 'medOffer', 'med_offer', 'smlOffer', 'sml_offer']) {
                        const tier = field<Record<string, unknown>>(offerList, tierKey);
                        const remaining = field<number>(tier, 'remaining');
                        if (remaining && remaining > 0) {
                            offersLive = true;
                            break;
                        }
                    }
                }

                if (!cancelled) {
                    setData({ ammState, offerList, metrics, acceptedOffers: accepted, offersLive, loading: false, error: null });
                }
            } catch (err) {
                if (!cancelled) {
                    setData(prev => ({ ...prev, loading: false, error: err instanceof Error ? err.message : 'RPC fetch failed' }));
                }
            }
        }

        load();
        const timer = setInterval(load, 30_000);
        return () => { cancelled = true; clearInterval(timer); };
    }, [connection]);

    return data;
}
