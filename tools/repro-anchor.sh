#!/bin/bash
# Reproduce `anchor deploy` (fresh + upgrade) against a local validator.
set -u
cd /home/kev/dev/sol/testy-token/consolidated-testy-token
SOLANA=/home/kev/dev/sol/agave-3.1.8/bin
rm -rf /tmp/sol-ledger4
$SOLANA/solana-test-validator --reset --ledger /tmp/sol-ledger4 --quiet > /tmp/validator5.log 2>&1 &
VPID=$!
UP=0
for i in $(seq 1 40); do
    if $SOLANA/solana cluster-version --url http://127.0.0.1:8899 > /dev/null 2>&1; then UP=1; break; fi
    sleep 2
done
if [ "$UP" = "1" ]; then
    $SOLANA/solana airdrop 20 --url http://127.0.0.1:8899 > /dev/null 2>&1 || true
    echo "=== anchor deploy #1 (fresh) ==="
    anchor deploy crank_oracle --provider.cluster http://127.0.0.1:8899 2>&1 | tail -12
    echo "=== anchor deploy #2 (upgrade) ==="
    anchor deploy crank_oracle --provider.cluster http://127.0.0.1:8899 2>&1 | tail -12
fi
kill $VPID 2>/dev/null
wait $VPID 2>/dev/null
echo done
