#!/usr/bin/env bash
# End-to-end browser QA for BUILDINTEL. Needs: Node 20+, Python 3 with `pip install -r qa/requirements.txt` and `playwright install chromium`.
# Usage: bash qa/run.sh      (from the project root). Exits non-zero if any check fails.
#        CORE_READS=on bash qa/run.sh   runs the same checks with permanent-project reads (phase 2) switched on.
set -u
cd "$(dirname "$0")/.."
export QA_OUT="${QA_OUT:-$(mktemp -d)}"; mkdir -p "$QA_OUT"; FAIL=0; PIDS=()
start() { CORE_READS="${CORE_READS:-off}" LOGIN_RATE_LIMIT=1000 DOC_DIR="$(mktemp -d)" QA_PORT=$2 node "qa/$1" > "$QA_OUT/$1.log" 2>&1 & PIDS+=($!); for i in $(seq 1 40); do grep -qs up "$QA_OUT/$1.log" && return; sleep 0.25; done; echo "server $1 did not start"; cat "$QA_OUT/$1.log"; exit 1; }
# Each check that uses the main demo server starts from a clean one: earlier checks change shared state
# (suspensions, plan access, sign-in counts), and a check must not depend on what ran before it.
reset_main() { kill "${MAIN_PID:-}" 2>/dev/null; sleep 1; start world-main.mjs 4401; MAIN_PID=${PIDS[-1]}; }
check() { local name="$1" want="$2"; shift 2; out=$("$@" 2>&1); if echo "$out" | grep -q -- "$want"; then echo "PASS  $name"; else echo "FAIL  $name"; echo "$out" | tail -15; FAIL=1; fi; }
start world-main.mjs 4401; start world-estimate.mjs 4402; start world-rich.mjs 4403
check "menu routing (every menu item opens its own page)" "PROBLEMS: \[\]" python3 qa/menu_routing.py 4401
check "every screen loads without errors"                 "buyer view loaded: True" python3 qa/screens.py
check "dead controls (main accounts)"                       "dead controls: 0" python3 qa/dead_controls.py 4401 sub@em.test,eric@bc.test,pm@acme.test
check "dead controls (rich project incl. profile tabs)"    "dead controls: 0" python3 qa/dead_controls.py 4403 sub@em.test
QA_PORT=4403 check "super admin phase 3 (projects, packages, plan access, documents, mobile menu)" "PROBLEMS: \[\]" python3 qa/admin_phase3_flow.py
reset_main; QA_PORT=4401 check "plan room + addenda flow"      "PROBLEMS: \[\]" python3 qa/planroom_flow.py
reset_main; QA_PORT=4401 check "bid leveling + prequalification" "PROBLEMS: \[\]" python3 qa/bid_leveling_flow.py
reset_main; QA_PORT=4401 check "super admin portal (dashboard, companies, suspend/reactivate, users, roles, audit, mobile)" "PROBLEMS: \[\]" python3 qa/admin_flow.py
reset_main; QA_PORT=4401 check "super admin phase 5 (analytics, queue, support, incidents, privacy, jobs & health, exports)" "PROBLEMS: \[\]" python3 qa/admin_phase5_flow.py
reset_main; QA_PORT=4401 check "super admin phase 4 + MFA (subscriptions, sources, AI limits, authenticator sign-in, phone cards)" "PROBLEMS: \[\]" python3 qa/admin_phase4_flow.py
reset_main; QA_PORT=4401 check "project publishing (draft → checklist → publish → invited)" "PROBLEMS: \[\]" python3 qa/publishing_flow.py
QA_PORT=4402 check "drawing takeoff (6,400 SF / 80 LF)" "PROBLEMS: \[\]" python3 qa/takeoff_flow.py
QA_PORT=4402 check "AI analysis → estimate → bid"     "PROBLEMS: \[\]" python3 qa/estimate_flow.py
QA_PORT=4401 check "role sign-up and workspace banners (GC/GM, owner, subcontractor, service provider)" "PROBLEMS: \[\]" python3 qa/roles_flow.py
QA_PORT=4401 check "Super Admin review screens (publisher verification, owner authority, company record)" "PROBLEMS: \[\]" python3 qa/staff_review_flow.py
QA_PORT=4401 check "public website (homepage, every page, mobile menu, sign-in hand-off to /app, clean console)" "PROBLEMS: \[\]" python3 qa/website_flow.py
kill "${PIDS[@]}" 2>/dev/null
echo "mode: CORE_READS=${CORE_READS:-off} · screenshots and logs: $QA_OUT"; exit $FAIL
