#!/usr/bin/env bash
#
# scripts/acceptance.sh — the Mags Commerce OS acceptance GATE.
#
# Regenerates the seeded real-tenant DB FROM SCRATCH (import-square-ledger →
# seed-mags-tenant) into a disposable scratch DB, then runs the 20-journey
# acceptance harness against it. Two independent fail-closed checks:
#
#   1. the harness itself is fail-closed (watchdog + exit-guard + explicit
#      "expected 20, got N" assertion — see acceptance-journeys.ts), AND
#   2. this script greps the CAPTURED output (via `tee`, never a `>` redirect
#      that truncates on a fast async-stdout exit) for the literal success line
#      and FAILS if it is absent — regardless of the harness exit code.
#
# A partial or deadlocked run (the confirmDoubleOptIn deadlock that used to make
# the harness drain the loop and exit 0 with no 20/20 table) fails BOTH checks.
#
# Requires the real Mags ledger (~/MagsTack/ledger.db) — a ~33MB local artifact
# NOT committed to the repo. Override with LEDGER_DB_PATH.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TSX="$ROOT/node_modules/.bin/tsx"
LEDGER="${LEDGER_DB_PATH:-$HOME/MagsTack/ledger.db}"
TENANT="Mags Tack"
PASS_LINE='ALL 20 ACCEPTANCE JOURNEYS PASSED'

if [[ ! -x "$TSX" ]]; then
  echo "acceptance: tsx not found at $TSX — run \`npm install\` first." >&2
  exit 1
fi
if [[ ! -f "$LEDGER" ]]; then
  echo "acceptance: ledger db not found at $LEDGER." >&2
  echo "acceptance: this gate requires the real Mags ledger (a local artifact, not in the repo)." >&2
  echo "acceptance: set LEDGER_DB_PATH to point at it." >&2
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/mags-acceptance.XXXXXX")"
DB="$WORK/mags-template.db"
LOG="$WORK/journeys.log"
trap 'rm -rf "$WORK"' EXIT

echo "acceptance: ledger   = $LEDGER"
echo "acceptance: work dir = $WORK"

echo "acceptance: [1/3] import-square-ledger → create/resolve the '$TENANT' tenant"
PLATFORM_STORAGE_DIR="$WORK/storage" PLATFORM_DB_PATH="$DB" \
  "$TSX" "$ROOT/apps/api/src/import-square-ledger.ts" --ledger "$LEDGER" --tenant "$TENANT"

echo "acceptance: [2/3] seed-mags-tenant → populate the module tables + verify against the ledger"
PLATFORM_DB_PATH="$DB" LEDGER_DB_PATH="$LEDGER" \
  "$TSX" "$ROOT/apps/api/src/seed-mags-tenant.ts"

echo "acceptance: [3/3] run the 20-journey acceptance harness against the fresh template"
set +e
TEMPLATE_DB_PATH="$DB" "$TSX" "$ROOT/apps/api/src/acceptance-journeys.ts" 2>&1 | tee "$LOG"
HARNESS_STATUS="${PIPESTATUS[0]}"
set -e

echo "acceptance: harness exit status = $HARNESS_STATUS"

# Belt-and-suspenders literal-line gate. grep reads a FILE (not a pipe), so no
# SIGPIPE/pipefail surprise; `-F` = fixed string. Absent line => FAIL, whatever
# the exit code was.
if ! grep -qF "$PASS_LINE" "$LOG"; then
  echo "acceptance: FAIL — success line \"$PASS_LINE\" NOT found in harness output." >&2
  echo "acceptance: a partial/deadlocked run prints no 20/20 table — this is the fail-open guard." >&2
  exit 1
fi
if [[ "$HARNESS_STATUS" -ne 0 ]]; then
  echo "acceptance: FAIL — harness exited non-zero ($HARNESS_STATUS)." >&2
  exit "$HARNESS_STATUS"
fi

echo "acceptance: PASS — 20/20 journeys, success line present, harness exit 0."
