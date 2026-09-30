#!/usr/bin/env bash
# spike 全量跑数:输出进 results/(throwaway)
set -u
cd "$(dirname "$0")"
mkdir -p results
for m in m1-interrupt m2-memory m3-runaway m4-async m6-boundary m7-doc-gaps; do
  echo "== $m =="
  node "$m.mjs" > "results/$m.txt" 2>&1
  echo "  -> results/$m.txt (exit $?)"
done
# M5:跑两遍 diff FROZEN_* 行 → 重跑一致性
node m5-determinism.mjs > results/m5-run1.txt 2>&1
node m5-determinism.mjs > results/m5-run2.txt 2>&1
grep '^FROZEN' results/m5-run1.txt > results/m5-run1.frozen
grep '^FROZEN' results/m5-run2.txt > results/m5-run2.frozen
if diff -q results/m5-run1.frozen results/m5-run2.frozen > /dev/null; then
  echo "M5 rerun-diff: IDENTICAL" | tee results/m5-rerun-verdict.txt
else
  echo "M5 rerun-diff: DIFFERENT" | tee results/m5-rerun-verdict.txt
  diff results/m5-run1.frozen results/m5-run2.frozen
fi
cat results/m5-run1.txt
