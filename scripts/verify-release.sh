#!/usr/bin/env bash
# Release verification: everything a release must pass, run in a CLEAN copy (fresh `npm ci` from the lockfile).
# Needs: Node (see package.json engines), PostgreSQL reachable at TEST_DATABASE_URL, Python 3 + qa/requirements.txt
# (`pip install -r qa/requirements.txt && playwright install chromium`).
# Usage: TEST_DATABASE_URL=postgres://... bash scripts/verify-release.sh      → writes docs/RELEASE-VERIFICATION.md
set -u
SRC="$(cd "$(dirname "$0")/.." && pwd)"; WORK="$(mktemp -d)"; LOGS="$WORK/logs"; mkdir -p "$LOGS"
mkdir -p "$WORK/app"; (cd "$SRC" && tar --exclude=./node_modules --exclude=./test-results --exclude='./data/*.json' --exclude='__pycache__' -cf - .) | (cd "$WORK/app" && tar -xf -)
cd "$WORK/app"
RESULTS=(); FAILED=0
step() { local name="$1"; shift; local log="$LOGS/$(echo "$name" | tr ' /' '__').log"; local t0=$(date +%s)
  if "$@" > "$log" 2>&1; then RESULTS+=("| $name | PASS | $(( $(date +%s) - t0 ))s |"); echo "PASS  $name"
  else RESULTS+=("| $name | **FAIL** | $(( $(date +%s) - t0 ))s |"); echo "FAIL  $name (log: $log)"; tail -20 "$log"; FAILED=1; fi; }
step "Clean install (npm ci, lockfile)"         npm ci
step "Environment (Node, dependencies, PostgreSQL)" node scripts/doctor.mjs --db
step "All automated tests (no failures, no skips)"  node scripts/test-ci.mjs
step "Dependency security audit"                 npm audit --omit=dev --audit-level=moderate
step "Browser QA, CORE_READS=off"                env CORE_READS=off QA_OUT="$LOGS/qa-core-off" bash qa/run.sh
step "Browser QA, CORE_READS=on"                 env CORE_READS=on QA_OUT="$LOGS/qa-core-on" bash qa/run.sh
SUMMARY=$(grep -h "^test-ci:" "$LOGS"/All_automated* 2>/dev/null | tail -1)
qa() { local f="$LOGS/Browser_QA,_CORE_READS=$1.log"; echo "$(grep -c '^PASS' "$f" 2>/dev/null || echo 0)/$(grep -cE '^(PASS|FAIL)' "$f" 2>/dev/null || echo 0)"; }   # passed/total, counted from the log
QAOFF=$(qa off); QAON=$(qa on)
{ echo "# Release verification"; echo
  echo "Result: **$([ $FAILED = 0 ] && echo 'PASS — release verified' || echo 'FAIL — do not release')**"; echo
  echo "- Verified at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "- App version: $(node -p "require('./package.json').version") · lockfile sha256: $(sha256sum package-lock.json | cut -c1-16)"
  echo "- Git commit: $(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo 'not a git checkout (zip)')"
  echo "- Source sha256: $(bash "$SRC/scripts/source-hash.sh") (recompute on your copy with \`bash scripts/source-hash.sh\`)"
  echo "- Node $(node --version) · PostgreSQL: $(grep -ho 'PostgreSQL [0-9.]*' "$LOGS"/Environment* | head -1)"
  echo "- Tests: ${SUMMARY:-not run}"; echo "- Browser QA checks passed: off ${QAOFF}, on ${QAON}"; echo
  echo "| Step | Result | Time |"; echo "|---|---|---|"; printf '%s\n' "${RESULTS[@]}"; echo
  echo "Logs: \`$LOGS\` (kept on the machine that ran this)."; } > "$SRC/docs/RELEASE-VERIFICATION.md"
# Evidence kept with the release: every log, the full test output, browser screenshots, and a fingerprint manifest.
EVID="$SRC/release-evidence"; rm -rf "$EVID"; mkdir -p "$EVID"
cp -r "$LOGS"/. "$EVID"/; cp test-results/test-ci.log "$EVID/test-ci-full.log" 2>/dev/null || true
cp "$SRC/docs/RELEASE-VERIFICATION.md" "$EVID/RELEASE-VERIFICATION.md"
find "$EVID" -name '*.log' -size +5M -exec sh -c 'tail -c 5000000 "$1" > "$1.tmp" && mv "$1.tmp" "$1"' _ {} \;   # cap huge logs
(cd "$EVID" && find . -type f ! -name MANIFEST.sha256 | sort | xargs sha256sum > MANIFEST.sha256)
echo "- Evidence: \`release-evidence/\` ($(find "$EVID" -type f | wc -l) files; verify with \`cd release-evidence && sha256sum -c MANIFEST.sha256\`)" >> "$SRC/docs/RELEASE-VERIFICATION.md"
cp "$SRC/docs/RELEASE-VERIFICATION.md" "$EVID/RELEASE-VERIFICATION.md"; (cd "$EVID" && find . -type f ! -name MANIFEST.sha256 | sort | xargs sha256sum > MANIFEST.sha256)
cat "$SRC/docs/RELEASE-VERIFICATION.md"; exit $FAILED
