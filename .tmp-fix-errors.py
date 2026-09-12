#!/usr/bin/env python3
"""One-shot migration: 11 per-module ErrorCode enums -> crate::error::AmmError."""
import pathlib
import re
import sys

ROOT = pathlib.Path("programs/amm/src/instructions")

# Files with a local #[error_code] enum to delete, and per-file variant renames.
ENUM_FILES = {
    "alt_offers.rs": {"InvalidMarketState": "AltSheetRequiresSuspension"},
    "bounty_top_up.rs": {},
    "buy_the_dip.rs": {},
    "calc_completed_offers.rs": {},
    "dex_buyback.rs": {"InvalidMarketState": "MarketNotOpen"},
    "distribute_staker_rewards.rs": {"InvalidMarketState": "MarketNotOpen"},
    "make_offers.rs": {},
    "offer_claim.rs": {},
    "set_cpmm_pool.rs": {},
    "set_sol_usdc_pool.rs": {},
    "update_tradeday_stats.rs": {},
}
# Files that use the enum without defining one (full-path references).
PATH_ONLY_FILES = {"load_offers.rs": []}

BLOCK_RE = re.compile(
    r"\n?#\[error_code\]\s*\n(?:pub\(crate\) )?enum ErrorCode \{.*?\n\}\n?", re.DOTALL
)

def migrate(path: pathlib.Path, renames: dict[str, str]) -> list[str]:
    text = path.read_text()
    changed = []
    if "#[error_code]" in text:
        new_text, n = BLOCK_RE.subn("", text)
        assert n == 1, f"{path}: expected 1 error_code block, found {n}"
        text = new_text
        changed.append("deleted local error enum")
    # Usage sites (bare references inside the file).
    text = re.sub(r"ErrorCode::", "AmmError::", text)
    # load_offers uses a full path to the old make_offers enum.
    text = re.sub(
        r"crate::instructions::make_offers::AmmError::", "AmmError::", text
    )
    for old, new in renames.items():
        text, k = re.subn(rf"AmmError::{old}\b", f"AmmError::{new}", text)
        if k:
            changed.append(f"renamed {old} -> {new} ({k})")
    # Import the canonical table.
    m = re.search(r"^use anchor_lang::prelude::\*;\n", text, re.M)
    assert m, f"{path}: no prelude import found"
    text = text[: m.end()] + "\nuse crate::error::AmmError;\n" + text[m.end():]
    changed.append("added AmmError import")
    # Collapse blank runs left by the block removal.
    text = re.sub(r"\n{3,}", "\n\n", text)
    path.write_text(text)
    return changed

for fname, renames in ENUM_FILES.items():
    print(fname, "->", migrate(ROOT / fname, renames))
for fname, renames in PATH_ONLY_FILES.items():
    print(fname, "->", migrate(ROOT / fname, renames))
