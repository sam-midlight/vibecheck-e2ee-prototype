#!/usr/bin/env bash
# Run every scripts/test-*.ts sequentially and record pass/fail + timing.
# Writes: /tmp/e2ee-test-run/summary.tsv  (tab: status\tseconds\tfile)
#         /tmp/e2ee-test-run/logs/<name>.log  (per-test full output)
#         /tmp/e2ee-test-run/progress.log      (live running log)

set -u
OUT=/tmp/e2ee-test-run
mkdir -p "$OUT/logs"
: > "$OUT/summary.tsv"
: > "$OUT/progress.log"

PASS=0
FAIL=0
i=0
TOTAL=$(wc -l < "$OUT/list.txt")

while IFS= read -r test; do
  i=$((i+1))
  name=$(basename "$test" .ts)
  start=$(date +%s)
  printf "[%d/%d] %s ... " "$i" "$TOTAL" "$name" >> "$OUT/progress.log"
  if npx tsx --env-file=.env.local "$test" > "$OUT/logs/$name.log" 2>&1; then
    status=PASS
    PASS=$((PASS+1))
  else
    status=FAIL
    FAIL=$((FAIL+1))
  fi
  end=$(date +%s)
  dur=$((end-start))
  printf "%s\t%d\t%s\n" "$status" "$dur" "$name" >> "$OUT/summary.tsv"
  printf "%s (%ds)\n" "$status" "$dur" >> "$OUT/progress.log"
done < "$OUT/list.txt"

printf "\n=== DONE ===\nPASS=%d FAIL=%d TOTAL=%d\n" "$PASS" "$FAIL" "$TOTAL" >> "$OUT/progress.log"
