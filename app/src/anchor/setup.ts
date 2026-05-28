import { AnchorProvider, Program, web3 } from "@coral-xyz/anchor";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { useMemo } from "react";
import stakingIdl from "../../../target/idl/staking.json";
import crankIdl from "../../../target/idl/crank_oracle.json";

// Derive directly from the built IDL — never stale
const stakingAddress = (stakingIdl as any).metadata?.address ?? (stakingIdl as any).address;
const crankAddress = (crankIdl as any).metadata?.address ?? (crankIdl as any).address;

export const STAKING_PROGRAM_ID = new web3.PublicKey(stakingAddress);
export const CRANK_PROGRAM_ID = new web3.PublicKey(crankAddress);

export function useStakingProgram() {
    const { connection } = useConnection();
    const wallet = useAnchorWallet();

    return useMemo(() => {
        if (!wallet) return null;
        const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
        // Explicitly pass the ID so there is zero chance of mismatch
        return new Program(stakingIdl as any, provider);
    }, [connection, wallet]);
}

export function useCrankProgram() {
    const { connection } = useConnection();
    const wallet = useAnchorWallet();

    return useMemo(() => {
        if (!wallet) return null;
        const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
        return new Program(crankIdl as any, provider);
    }, [connection, wallet]);
}
