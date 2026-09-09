#!/usr/bin/env python3
# Verified formula: rent-exempt = (data_len + 128) * lamports_per_byte
# Probed with solana-cli 3.1.8: 5,080 lamports/byte (devnet/reduced rate); mainnet current ~6,334.
def rent(size, rate):
    return (size + 128) * rate / 1e9

print("=== Deployment cost model (reduced rate 5,080; mainnet current 6,334) ===")
programs = [
    ("amm.so", 656704),
    ("crank_oracle.so", 305512),
    ("staking.so", 414944),
    ("IDL amm.json (optional on-chain)", 71882),
    ("IDL crank_oracle.json (optional)", 18474),
    ("IDL staking.json (optional)", 20321),
]
tot5080 = tot6334 = 0.0
for name, size in programs:
    r5 = rent(size, 5080)
    r6 = rent(size, 6334)
    tot5080 += r5
    tot6334 += r6
    print(f"{name:38s} {size:>8,} B   {r5:7.4f} SOL @5080   {r6:7.4f} SOL @6334")
print(f"{'TOTAL programs + IDLs':38s} {'':>10} {tot5080:7.4f} SOL       {tot6334:7.4f} SOL")
print()
print("=== Per-KB marginal cost ===")
print(f"1 KB of ELF: {1024*5080/1e9:.4f} SOL @5080 | {1024*6334/1e9:.4f} SOL @6334")
print()
print("=== State rent inventory (per account, @5080) ===")
state = [
    ("token account (ATA, 165 B)", 165),
    ("StakePosition (~146 B)", 146),
    ("UserStakeIndex (16 B)", 16),
    ("space-0 PDA (vestigial sol_*)", 0),
    ("AmmState (~600 B est)", 600),
    ("MarketMetrics (~310 B est)", 310),
    ("OfferList (104 B)", 104),
    ("AcceptedOffers (~40 B)", 40),
    ("StakePool (~250 B est)", 250),
    ("market_status (25 B)", 25),
]
for name, size in state:
    print(f"{name:38s} {size:>8} B   {rent(size,5080):7.4f} SOL  | compressed-PDA path ~0.000005 SOL")
print()
print("=== Per-staker rent (SPL path) ===")
per = rent(146,5080) + rent(16,5080) + rent(165,5080)
print(f"position+index+ATA = {per:.4f} SOL/staker")
for n in (1000, 5000, 50000):
    print(f"  {n:>6} stakers -> {per*n:8.1f} SOL   (compressed-PDA+token path: ~{n*(0.000005+0.000011):.2f} SOL)")
print()
print("=== Shrink estimates ===")
program_rent = sum(rent(s, 5080) for _, s in programs[:3])
idl_rent = sum(rent(s, 5080) for _, s in programs[3:])
print(f"drop on-chain IDLs: -{idl_rent:.3f} SOL")
print(f"crank-oracle native (298K->~90K est): -{rent(305512,5080)-rent(90000,5080):.3f} SOL")
print(f"staking native (405K->~90K est): -{rent(414944,5080)-rent(90000,5080):.3f} SOL")
print(f"amm native (641K->~300K est): -{rent(656704,5080)-rent(300000,5080):.3f} SOL")
