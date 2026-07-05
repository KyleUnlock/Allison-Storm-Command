#!/usr/bin/env bash
# smoke.sh — hit the local server's key endpoints and assert 8 checks.
#
# SIDE EFFECT: this script CREATES 2 TEST LEADS via POST /api/leads
# (one "web", one "ad"). Run it against a dev/in-memory server, not prod.
#
# Usage:
#   node serve.local.js &            # start the app on :4010
#   BOARD_PASSWORD=AllisonStorm-Cmd-2026 REP_CREDENTIALS="alice:secret123" bash smoke.sh
set -u

BASE="${BASE:-http://localhost:4010}"
BOARD_PW="${BOARD_PASSWORD:-AllisonStorm-Cmd-2026}"
pass=0; fail=0
check() { # desc  expected  actual
  if [ "$2" = "$3" ]; then echo "ok  - $1 ($3)"; pass=$((pass+1));
  else echo "FAIL- $1 (expected $2, got $3)"; fail=$((fail+1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# 1. public intake accepts a web lead (creates TEST LEAD #1)
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/leads" \
  -H 'Content-Type: application/json' -d '{"source":"web","name":"Smoke Web","phone":"5551230001"}')
check "POST /api/leads web -> 201" 201 "$c"

# 2. public intake accepts an ad lead (creates TEST LEAD #2)
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/leads" \
  -H 'Content-Type: application/json' -d '{"source":"ad","name":"Smoke Ad","phone":"5551230002"}')
check "POST /api/leads ad -> 201" 201 "$c"

# 3. public intake REJECTS gated source "storm"
c=$(code -X POST "$BASE/api/leads" -H 'Content-Type: application/json' -d '{"source":"storm","phone":"5550000000"}')
check "POST /api/leads storm -> 400" 400 "$c"

# 4. storm-status is public and returns 200
c=$(code "$BASE/api/storm-status?zip=75002")
check "GET /api/storm-status -> 200" 200 "$c"

# 5. board is gated: no password -> 401
c=$(code "$BASE/api/board")
check "GET /api/board (no pw) -> 401" 401 "$c"

# 6. board with correct password -> 200
c=$(code -H "X-Board-Password: $BOARD_PW" "$BASE/api/board")
check "GET /api/board (pw) -> 200" 200 "$c"

# 7. my-leads without a rep session -> 401
c=$(code "$BASE/api/my-leads")
check "GET /api/my-leads (no session) -> 401" 401 "$c"

# 8. rep login with a wrong passcode -> 401
c=$(code -X POST "$BASE/api/rep-login" -H 'Content-Type: application/json' -d '{"name":"alice","passcode":"nope"}')
check "POST /api/rep-login (wrong) -> 401" 401 "$c"

echo "-----"
echo "smoke: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
