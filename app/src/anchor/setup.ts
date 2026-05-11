import { AnchorProvider, Program, web3 } from "@coral-xyz/anchor";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { useMemo } from "react";
import stakingIdl from "../../../target/idl/staking.json";
import crankIdl from "../../../target/idl/crank_oracle.json";

export const STAKING_PROGRAM_ID = new web3.PublicKey("8CzYeKYrQieo6wXsQZ4fJB1otLgUwHAf5L1R8Sht1LX1");
export const CRANK_PROGRAM_ID = new web3.PublicKey("GsUHrYWJVUeMkDAFDRq2s8hJXwmg8fYCQjJ6ApbFK1as");

export function useStakingProgram() {
    const { connection } = useConnection();
    const wallet = useAnchorWallet();

    return useMemo(() => {
        if (!wallet) return null;
        const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
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
