#!/usr/bin/env bash
# Phase-0 micro-benchmark: runs the sample app in 4 variants and checks the verdict matrix.
# Usage: bash bench/run.sh [--model mock|claude-opus-5-5] [--port 3077]
set -uo pipefail
cd "$(dirname "$0")/.."
MODEL=${REVLEE_MODEL:-mock}; PORT=3077
while [ $# -gt 0 ]; do case "$1" in --model) MODEL=$2; shift 2;; --port) PORT=$2; shift 2;; *) shift;; esac; done
export PLAYWRIGHT_CHROMIUM_PATH=${PLAYWRIGHT_CHROMIUM_PATH:-$(ls -d /opt/pw-browsers/chromium-*/chrome-linux*/chrome 2>/dev/null | head -1)}
[ -d dist ] || npm run build >/dev/null
PORT=$PORT node sample-app/server.mjs >/tmp/revlee-sample-app.log 2>&1 & SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 1
PLAN_ARG=""; [ "$MODEL" = "mock" ] && PLAN_ARG="--plan fixtures/pr88/plan.mock.json"
declare -A CASES=( [good]="variant=pr" [bug-toast]="variant=pr&bug=toast-name" [bug-badge]="variant=pr&bug=badge" [bug-color]="variant=pr&bug=color" )
declare -A EXPECT=( [good]="ready" [bug-toast]="failed:AC2" [bug-badge]="failed:AC3" [bug-color]="failed:AC1" )
ok=0; total=0
printf "%-10s %-10s %-14s %-8s %s\n" case expected verdict usd failing
for name in good bug-toast bug-badge bug-color; do
  out=".revlee-run/bench-$MODEL-$name"; rm -rf "$out"
  node dist/cli.js verify --context fixtures/pr88/task_context.json $PLAN_ARG --model "$MODEL" \
    --url "http://localhost:$PORT/?${CASES[$name]}" --base-url "http://localhost:$PORT/?variant=base" --out "$out" >"$out.log" 2>&1
  summary=$(grep -o 'revlee:summary {.*}' "$out/report.md" 2>/dev/null | sed 's/revlee:summary //')
  verdict=$(echo "$summary" | sed -n 's/.*"verdict":"\([a-z_]*\)".*/\1/p')
  usd=$(echo "$summary" | sed -n 's/.*"cost_usd":\([0-9.]*\).*/\1/p')
  failing=$(grep -E '^\| AC[0-9]+ .*❌' "$out/report.md" 2>/dev/null | sed -n 's/^| \(AC[0-9]*\).*/\1/p' | paste -sd, -)
  want=${EXPECT[$name]}; wantV=${want%%:*}; wantAC=${want#*:}; [ "$wantAC" = "$want" ] && wantAC=""
  total=$((total+1))
  if [ "$verdict" = "$wantV" ] && { [ -z "$wantAC" ] || [ "$failing" = "$wantAC" ]; }; then ok=$((ok+1)); mark="OK"; else mark="MISMATCH"; fi
  printf "%-10s %-10s %-14s %-8s %-6s %s\n" "$name" "$wantV" "${verdict:-error}" "${usd:-0}" "${failing:--}" "$mark"
done
echo "score: $ok/$total correct verdicts (model=$MODEL)"
[ $ok -eq $total ]
