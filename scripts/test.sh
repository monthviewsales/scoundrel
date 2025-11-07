#!/usr/bin/env bash
set -euo pipefail

# --- 0) Env sanity -----------------------------------------------------------
echo "==[0] Env check =="
export NODE_ENV=development                 # verbose logs for this run
export OPENAI_RESPONSES_MODEL=${OPENAI_RESPONSES_MODEL:-gpt-4.1-mini}
: "${OPENAI_API_KEY:?Missing OPENAI_API_KEY}"
: "${SOLANATRACKER_API_KEY:?Missing SOLANATRACKER_API_KEY}"
echo "OPENAI_RESPONSES_MODEL=$OPENAI_RESPONSES_MODEL"

# Choose a wallet + alias for testing
WALLET="${1:-2kv8X2a9bxnBM8NKLc6BBTX2z13GFNRL4oRotMUJRva9}"
ALIAS="${2:-Gh0stee}"
LIMIT="${3:-500}"

# Clean old artifacts to avoid confusion (optional)
rm -f "profiles/${ALIAS}.json" || true

# --- 1) CLI help / self-check ------------------------------------------------
echo -e "\n==[1] CLI help & self-check =="
node index.js --help | head -n 20
node index.js test

# --- 2) Build profile (harvest trades + chart, Responses job) ----------------
echo -e "\n==[2] Build profile =="
node index.js build-profile "$WALLET" -n "$ALIAS" -l "$LIMIT"

# Verify profile artifact exists and is JSON
echo -e "\n==[2a] Verify profile output =="
test -f "profiles/${ALIAS}.json"
jq 'keys' "profiles/${ALIAS}.json" | sed -e 's/.*/  &/'
echo "OK: profiles/${ALIAS}.json present"

# --- 3) Ask over the profile -------------------------------------------------
echo -e "\n==[3] Ask =="
node index.js ask -n "$ALIAS" -q "In 2 lines, summarize this wallet's style."

# --- 4) Tune advice over the profile ----------------------------------------
echo -e "\n==[4] Tune =="
node index.js tune -n "$ALIAS" | sed -e 's/.*/  &/'

# --- 5) Dev artifacts sanity (samples saved) ---------------------------------
echo -e "\n==[5] Dev artifacts (samples) =="
ls -1 data | grep -E "${WALLET}-(raw|chart)-sample-" | head -n 4 || echo "No dev samples (OK in production mode)."

# --- 6) Edge cases -----------------------------------------------------------
echo -e "\n==[6] Edge cases =="
echo "-- Missing profile (expect error):"
if node index.js ask -n "does_not_exist" -q "hello"; then
  echo "ERROR: expected failure for missing profile"; exit 2
else
  echo "OK: ask failed as expected for missing profile"
fi

echo "-- Small time window (expect possibly few trades):"
START=$(date -u -v-1d +"%Y-%m-%dT00:00:00Z" 2>/dev/null || date -u -d "yesterday 00:00" +"%Y-%m-%dT%H:%M:%SZ")
END=$(date -u +"%Y-%m-%dT23:59:59Z")
node index.js build-profile "$WALLET" -n "${ALIAS}_mini" --start "$START" --end "$END" -l 100 || true

echo -e "\nAll checks completed."