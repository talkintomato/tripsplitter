#!/usr/bin/env bash
# End to end check over real HTTP: starts the dev server against a temporary database, signed in as
# DEV_FAKE_USER, and calls the main routes with curl. Needs the Mini App to be built first.
#
#   pnpm web:build && bash test/api/smoke.sh
#
# PORT can be set to use another port (default 3457).
set -u
cd "$(dirname "$0")/../.."

PORT="${PORT:-3457}"
BASE="http://localhost:$PORT"
DIR="$(mktemp -d)"
LOG="$DIR/server.log"
FAILED=0

NODE_ENV=development PORT="$PORT" DATABASE_PATH="$DIR/smoke.db" \
  DEV_FAKE_USER='{"id":1,"first_name":"Dev"}' \
  node_modules/.bin/tsx src/api/dev-server.ts >"$LOG" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null; rm -rf "$DIR"' EXIT

for _ in $(seq 1 50); do
  curl -s -o /dev/null "$BASE/dev/launch" && break
  sleep 0.2
done

json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const r=new Function("v","return "+process.argv[1])(v);console.log(typeof r==="string"?r:JSON.stringify(r))})' "$1"; }

LAUNCH="$(curl -s "$BASE/dev/launch" | json 'v.launch')"
if [ -z "$LAUNCH" ]; then echo "The server did not start:"; cat "$LOG"; exit 1; fi

# call METHOD PATH [BODY] -> prints "STATUS BODY"
call() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path" -H "Authorization: tma dev" -H "X-Launch: ${USE_LAUNCH-$LAUNCH}" -H 'Content-Type: application/json' -d "$body"
  else
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path" -H "Authorization: tma dev" -H "X-Launch: ${USE_LAUNCH-$LAUNCH}"
  fi
}

# check NAME EXPECTED_STATUS EXPRESSION METHOD PATH [BODY]: the expression must be true for the body `v`.
check() {
  local name="$1" want="$2" expr="$3"; shift 3
  local out status body
  out="$(call "$@")"
  status="$(printf '%s' "$out" | tail -n 1)"
  body="$(printf '%s' "$out" | sed '$d')"
  LAST="$body"
  local ok
  ok="$(printf '%s' "$body" | json "$expr" 2>/dev/null)"
  if [ "$status" = "$want" ] && [ "$ok" = "true" ]; then
    echo "ok    $name ($status)"
  else
    echo "FAIL  $name: wanted $want and ($expr), got $status $body"
    FAILED=1
  fi
}
last() { printf '%s' "$LAST" | json "$1"; }

check 'GET /api/group' 200 'v.me.displayName==="Dev" && v.members.length===3 && v.activeTrip.homeCurrency==="SGD" && v.destination.view==="home"' GET /api/group
ME="$(last 'v.me.id')"; TRIP="$(last 'v.activeTrip.id')"
SAM="$(last 'v.members.find(m=>m.displayName==="Sam").id')"
PRIYA="$(last 'v.members.find(m=>m.displayName==="Priya").id')"

check 'GET /api/trips' 200 'v.trips.length===1' GET /api/trips
check 'PATCH /api/trips/:id' 200 'v.trip.name==="Smoke trip"' PATCH "/api/trips/$TRIP" '{"name":"Smoke trip"}'
check 'PATCH with one bad field changes nothing' 400 'v.error.code==="unsupported_currency"' PATCH "/api/trips/$TRIP" '{"name":"Nope","homeCurrency":"EUR"}'
check 'GET /api/trips/:id' 200 'v.trip.name==="Smoke trip"' GET "/api/trips/$TRIP"

EXPENSE="{\"payerId\":$ME,\"description\":\"Dinner\",\"expenseDate\":\"2026-09-27\",\"total\":1000,\"splitType\":\"even\",\"shares\":[{\"memberId\":$ME},{\"memberId\":$SAM},{\"memberId\":$PRIYA}]}"
check 'POST expense' 201 "v.expense.status===\"confirmed\" && v.expense.amounts[$ME]===334 && v.expense.createdBy===$ME" POST "/api/trips/$TRIP/expenses" "$EXPENSE"
ID="$(last 'v.expense.id')"
check 'GET expense' 200 'v.expense.total===1000 && v.expense.shares.length===3' GET "/api/expenses/$ID"
check 'PUT expense' 200 'v.expense.total===1200 && v.expense.version===2' PUT "/api/expenses/$ID" "${EXPENSE%\}},\"total\":1200,\"version\":1}"
check 'PUT with an old version' 409 'v.error.code==="stale" && v.error.current.version===2' PUT "/api/expenses/$ID" "${EXPENSE%\}},\"version\":1}"
check 'GET expenses' 200 'v.expenses.length===1' GET "/api/trips/$TRIP/expenses"

FOREIGN="${EXPENSE%\}},\"currency\":\"JPY\",\"total\":11240,\"status\":\"draft\"}"
check 'POST a draft in JPY looks up a rate' 201 'v.expense.status==="draft" && v.expense.fxRateSource==="trip" && v.rateSet.currency==="JPY" && v.expense.homeTotal>0' POST "/api/trips/$TRIP/expenses" "$FOREIGN"
DRAFT="$(last 'v.expense.id')"; DRAFT_VERSION="$(last 'v.expense.version')"
check 'GET drafts' 200 'v.expenses.length===1 && v.expenses[0].currency==="JPY"' GET "/api/trips/$TRIP/expenses?status=draft"
check 'POST confirm' 200 'v.expense.status==="confirmed"' POST "/api/expenses/$DRAFT/confirm" "{\"version\":$DRAFT_VERSION}"
check 'POST delete' 200 'v.expense.status==="deleted"' POST "/api/expenses/$DRAFT/delete" "{\"version\":$(last 'v.expense.version')}"
check 'POST restore' 200 'v.expense.status==="confirmed"' POST "/api/expenses/$DRAFT/restore" "{\"version\":$(last 'v.expense.version')}"

# By item: Paella x2 32.00 for Dev and Sam, Beer 4.50 for Sam, Bread 3.00 for everyone, tax 3.95 on top, tip 5.00.
# By hand: items 17.00, 21.50 and 1.00; tax and tip 8.95 in proportion give 3.85, 4.87 and 0.22; the cent left goes to Dev, who paid.
ITEMS="{\"payerId\":$ME,\"description\":\"Casa Pepe\",\"expenseDate\":\"2026-09-27\",\"total\":4845,\"tax\":395,\"taxIncluded\":false,\"tip\":500,\"splitType\":\"items\",\"shares\":[{\"memberId\":$ME},{\"memberId\":$SAM},{\"memberId\":$PRIYA}],\"items\":[{\"label\":\"Paella\",\"quantity\":2,\"amount\":3200,\"shares\":[{\"memberId\":$ME},{\"memberId\":$SAM}]},{\"label\":\"Beer\",\"amount\":450,\"shares\":[{\"memberId\":$SAM}]},{\"label\":\"Bread\",\"amount\":300}]}"
ITEM_AMOUNTS="v.amounts[$ME]===2086 && v.amounts[$SAM]===2637 && v.amounts[$PRIYA]===122"
check 'POST preview of an item split' 200 "v.problems.length===0 && v.difference===null && ${ITEM_AMOUNTS}" POST /api/expenses/preview "$ITEMS"
check 'POST preview with a total that is too high' 200 'v.amounts===null && v.difference===155 && v.problems[0].code==="total_mismatch"' POST /api/expenses/preview "${ITEMS/\"total\":4845/\"total\":5000}"
check 'POST preview with a member of no group' 400 'v.error.code==="member_not_in_group"' POST /api/expenses/preview "${ITEMS/\"payerId\":$ME/\"payerId\":999999}"
check 'a preview saves nothing' 200 'v.expenses.length===2' GET "/api/trips/$TRIP/expenses"
check 'POST an item split' 201 "v.expense.status===\"confirmed\" && v.expense.splitType===\"items\" && v.expense.items.length===3 && ${ITEM_AMOUNTS//v.amounts/v.expense.amounts}" POST "/api/trips/$TRIP/expenses" "$ITEMS"
ITEM_ID="$(last 'v.expense.id')"
# Saved again with the tip raised to 6.00: 9.95 in proportion gives 4.28, 5.41 and 0.25, and the cent left goes to Dev.
check 'PUT an item split' 200 "v.expense.version===2 && v.expense.tip===600 && v.expense.amounts[$ME]===2129 && v.expense.amounts[$SAM]===2691 && v.expense.amounts[$PRIYA]===125" PUT "/api/expenses/$ITEM_ID" "$(printf '%s' "${ITEMS%\}}" | sed 's/"total":4845/"total":4945/; s/"tip":500/"tip":600/'),\"version\":1}"
check 'GET the item split' 200 'v.expense.shares.filter(s=>s.itemId!==null).length===3 && v.expense.items[0].quantity===2 && v.expense.items[0].amount===3200' GET "/api/expenses/$ITEM_ID"

check 'GET balances' 200 "v.balances[$ME]>0 && v.payments.length>0 && v.settlements.length===0" GET "/api/trips/$TRIP/balances"
check 'POST settlement' 201 "v.settlement.status===\"active\" && v.settlement.createdBy===$ME" POST "/api/trips/$TRIP/settlements" "{\"fromMemberId\":$SAM,\"toMemberId\":$ME,\"amount\":400}"
SETTLEMENT="$(last 'v.settlement.id')"
check 'POST undo' 200 'v.settlement.status==="undone"' POST "/api/settlements/$SETTLEMENT/undo" '{"version":1}'
check 'POST restore settlement' 200 'v.settlement.status==="active"' POST "/api/settlements/$SETTLEMENT/restore" '{"version":2}'

check 'POST member' 201 'v.member.joinedVia==="manual"' POST /api/members '{"displayName":"Leo"}'
LEO="$(last 'v.member.id')"
check 'POST claim' 200 "v.me.id===$ME && !v.members.some(m=>m.id===$LEO)" POST "/api/members/$LEO/claim"
check 'GET activity' 200 'v.entries.length>10 && v.entries[0].actorName==="Dev"' GET /api/activity

check 'an unknown expense' 404 'v.error.code==="not_found"' GET /api/expenses/999999
USE_LAUNCH='' check 'no link' 401 'v.error.code==="unauthorized"' GET /api/group
USE_LAUNCH="${LAUNCH%?}x" check 'a forged link' 401 'v.error.code==="unauthorized"' GET /api/group

check 'POST end' 200 'v.trip.status==="ended"' POST "/api/trips/$TRIP/end"
check 'an expense on the ended trip' 400 'v.error.code==="trip_ended"' POST "/api/trips/$TRIP/expenses" "$EXPENSE"
check 'a settlement on the ended trip' 201 'v.settlement.tripId==='"$TRIP" POST "/api/trips/$TRIP/settlements" "{\"fromMemberId\":$PRIYA,\"toMemberId\":$ME,\"amount\":100}"
check 'POST reopen' 200 'v.trip.status==="active"' POST "/api/trips/$TRIP/reopen"

OLD="$LAUNCH"
check 'POST reset-link' 200 'v.group.linkVersion===2 && v.launch.length>10' POST /api/group/reset-link
LAUNCH="$(last 'v.launch')"
USE_LAUNCH="$OLD" check 'the old link after a reset' 403 'v.error.code==="link_invalid"' GET /api/group
check 'the new link after a reset' 200 'v.group.linkVersion===2' GET /api/group

PAGE="$(curl -s -w '\n%{http_code}' "$BASE/")"
if [ "$(printf '%s' "$PAGE" | tail -n 1)" = "200" ] && printf '%s' "$PAGE" | grep -q '<div id="root">'; then echo 'ok    GET / serves the Mini App (200)'; else echo 'FAIL  GET / does not serve the Mini App'; FAILED=1; fi
ASSET="$(printf '%s' "$PAGE" | grep -o '/assets/[^"]*\.js' | head -n 1)"
if [ -n "$ASSET" ] && [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$ASSET")" = "200" ]; then echo "ok    GET $ASSET (200)"; else echo "FAIL  the script of the Mini App is not served"; FAILED=1; fi

echo
echo "Notices the server would have posted:"
grep -c '^\[notice\]' "$LOG" | sed 's/^/  count: /'
grep -o '^\[notice\] [A-Za-z]*' "$LOG" | sort | uniq -c | sed 's/^/  /'

if [ "$FAILED" = "0" ]; then echo; echo 'Smoke test passed.'; else echo; echo 'Smoke test FAILED.'; echo '--- server log'; cat "$LOG"; fi
exit "$FAILED"
