#!/bin/bash
# One-shot local deploy reproduction: start validator, wait, deploy, report, cleanup.
set -u
cd /home/kev/dev/sol/testy-token/consolidated-testy-token
SOLANA=/home/kev/dev/sol/agave-3.1.8/bin
rm -rf /tmp/sol-ledger2
$SOLANA/solana-test-validator --reset --ledger /tmp/sol-ledger2 --quiet > /tmp/validator3.log 2>&1 &
VPID=$!
UP=0
for i in $(seq 1 40); do
    if $SOLANA/solana cluster-version --url http://127.0.0.1:8899 > /dev/null 2>&1; then
        echo "validator up after ${i} tries"
        UP=1
        break
    fi
    sleep 2
done
if [ "$UP" = "1" ]; then
    $SOLANA/solana airdrop 10 --url http://127.0.0.1:8899 > /dev/null 2>&1 || true
    echo "=== deploying crank_oracle.so ==="
    $SOLANA/solana program deploy target/deploy/crank_oracle.so --url http://127.0.0.1:8899 2>&1 | tail -15
    echo "=== deploy exit code recorded above ==="
fi
kill $VPID 2>/dev/null
wait $VPID 2>/dev/null
echo done
