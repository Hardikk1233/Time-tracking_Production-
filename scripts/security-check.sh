#!/bin/bash
# Attempts every exploit the audit found, against the running API.
API=http://localhost:8080/api
PSQL="/c/Users/AiEngineer/pgsql16/bin/psql.exe"
DB="-U postgres -h localhost -p 5432 -d timetracker -t -A -c"
PASS=0; FAIL=0

login() { rm -f "$2"; curl -s -c "$2" -X POST "$API/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$1\",\"password\":\"password123\"}" -o /dev/null; }

check() { # check <expected> <label> <curl args...>
  local want=$1; shift; local label=$1; shift; local got
  got=$(curl -s -o /tmp/_body -w "%{http_code}" "$@")
  if [ "$got" = "$want" ]; then
    PASS=$((PASS+1)); printf "  \033[32mPASS\033[0m  %-54s %s\n" "$label" "$got"
  else
    FAIL=$((FAIL+1)); printf "  \033[31mFAIL\033[0m  %-54s got %s want %s\n" "$label" "$got" "$want"
    head -c 200 /tmp/_body; echo
  fi
}

login ethan@timetrack.com /tmp/analyst.txt   # Analyst, reports to Priya
login priya@timetrack.com /tmp/assoc.txt     # Associate on Q3 Financial Audit
login james@timetrack.com /tmp/md.txt        # MD

ANALYST_ID=$("$PSQL" $DB "SELECT id FROM users WHERE email='ethan@timetrack.com';")
# An approved entry NOT belonging to the MD, so the self-approval rule doesn't mask the status rule.
APPROVED_OTHER=$("$PSQL" $DB "SELECT te.id FROM time_entries te JOIN users u ON u.id=te.user_id WHERE te.status='approved' AND u.email<>'james@timetrack.com' LIMIT 1;")
# A pending entry belonging to the analyst.
ANALYST_PENDING=$("$PSQL" $DB "SELECT id FROM time_entries WHERE status='pending' AND user_id=$ANALYST_ID LIMIT 1;")
# A pending entry belonging to someone else entirely.
OTHER_PENDING=$("$PSQL" $DB "SELECT id FROM time_entries WHERE status='pending' AND user_id<>$ANALYST_ID LIMIT 1;")
# A pending entry of Priya's own, to test self-approval.
PRIYA_PENDING=$("$PSQL" $DB "SELECT te.id FROM time_entries te JOIN users u ON u.id=te.user_id WHERE te.status='pending' AND u.email='priya@timetrack.com' LIMIT 1;")

echo "── Privilege escalation ────────────────────────────────────────────────────"
check 403 "analyst promotes self to MD" \
  -b /tmp/analyst.txt -X PATCH "$API/users/$ANALYST_ID" -H "Content-Type: application/json" -d '{"role":"md"}'
check 403 "analyst creates an MD account" \
  -b /tmp/analyst.txt -X POST "$API/users" -H "Content-Type: application/json" \
  -d '{"name":"X","email":"x@y.com","password":"averylongpassword","role":"md"}'
check 403 "analyst resets the MD's password" \
  -b /tmp/analyst.txt -X PATCH "$API/users/1" -H "Content-Type: application/json" -d '{"password":"averylongpassword"}'
check 403 "analyst deletes a user" -b /tmp/analyst.txt -X DELETE "$API/users/2"
check 403 "associate grants a role above their own" \
  -b /tmp/assoc.txt -X PATCH "$API/users/$ANALYST_ID" -H "Content-Type: application/json" -d '{"role":"avp"}'
check 403 "MD demotes themselves (would strand the tenant)" \
  -b /tmp/md.txt -X PATCH "$API/users/1" -H "Content-Type: application/json" -d '{"role":"analyst"}'

echo "── Approval integrity ──────────────────────────────────────────────────────"
check 403 "analyst approves an entry" -b /tmp/analyst.txt -X POST "$API/time-entries/$OTHER_PENDING/approve"
check 403 "analyst rejects an entry"  -b /tmp/analyst.txt -X POST "$API/time-entries/$OTHER_PENDING/reject"
check 403 "associate approves their OWN entry" -b /tmp/assoc.txt -X POST "$API/time-entries/$PRIYA_PENDING/approve"
check 409 "re-deciding an already-approved entry" -b /tmp/md.txt -X POST "$API/time-entries/$APPROVED_OTHER/approve"
check 403 "analyst reopens an approved entry (MD only)" -b /tmp/analyst.txt -X POST "$API/time-entries/$APPROVED_OTHER/reopen"

echo "── Approved hours are frozen ───────────────────────────────────────────────"
check 409 "MD edits hours on an approved entry" \
  -b /tmp/md.txt -X PATCH "$API/time-entries/$APPROVED_OTHER" -H "Content-Type: application/json" -d '{"hours":99}'
check 409 "MD deletes an approved entry" -b /tmp/md.txt -X DELETE "$API/time-entries/$APPROVED_OTHER"
check 409 "associate rewrites the billable split after approval" \
  -b /tmp/assoc.txt -X POST "$API/time-entries/$APPROVED_OTHER/split" -H "Content-Type: application/json" -d '{"billableHours":0}'
check 403 "analyst deletes another person's PENDING entry" \
  -b /tmp/analyst.txt -X DELETE "$API/time-entries/$OTHER_PENDING"
check 404 "analyst reads another person's entry by id" \
  -b /tmp/analyst.txt "$API/time-entries/$OTHER_PENDING"

echo "── Input validation ────────────────────────────────────────────────────────"
check 400 "negative hours" -b /tmp/analyst.txt -X POST "$API/time-entries" -H "Content-Type: application/json" \
  -d '{"projectId":1,"taskId":1,"hours":-5,"date":"2026-08-19"}'
check 400 "999 hours in a day" -b /tmp/analyst.txt -X POST "$API/time-entries" -H "Content-Type: application/json" \
  -d '{"projectId":1,"taskId":1,"hours":999,"date":"2026-08-19"}'
check 400 "impossible calendar date" -b /tmp/analyst.txt -X POST "$API/time-entries" -H "Content-Type: application/json" \
  -d '{"projectId":1,"taskId":1,"hours":4,"date":"2026-02-31"}'
check 400 "unknown role value" -b /tmp/md.txt -X POST "$API/users" -H "Content-Type: application/json" \
  -d '{"name":"X","email":"z@y.com","password":"averylongpassword","role":"superadmin"}'
check 400 "weak password" -b /tmp/md.txt -X POST "$API/users" -H "Content-Type: application/json" \
  -d '{"name":"X","email":"z@y.com","password":"short","role":"analyst"}'

echo "── Legitimate use still works ──────────────────────────────────────────────"
check 200 "MD reads the dashboard" -b /tmp/md.txt "$API/dashboard/client-hours"
check 200 "analyst lists their own entries" -b /tmp/analyst.txt "$API/time-entries"
check 201 "analyst logs their own time" \
  -b /tmp/analyst.txt -X POST "$API/time-entries" -H "Content-Type: application/json" \
  -d '{"projectId":1,"taskId":1,"hours":3.5,"date":"2026-08-19","description":"phase 1 test"}'
NEW_ID=$(grep -o '"id":[0-9]*' /tmp/_body | head -1 | cut -d: -f2)
check 200 "associate approves an in-scope entry"  -b /tmp/assoc.txt -X POST "$API/time-entries/$NEW_ID/approve"
check 200 "approver name is now visible"          -b /tmp/assoc.txt "$API/time-entries/$NEW_ID"
grep -q '"approvedByName":"Priya Nair"' /tmp/_body \
  && { PASS=$((PASS+1)); printf "  \033[32mPASS\033[0m  %-54s\n" "approvedByName populated (was always null)"; } \
  || { FAIL=$((FAIL+1)); printf "  \033[31mFAIL\033[0m  %-54s\n" "approvedByName populated"; }
check 200 "MD reopens it, then it is editable again" -b /tmp/md.txt -X POST "$API/time-entries/$NEW_ID/reopen"
check 200 "audit history is readable"                -b /tmp/assoc.txt "$API/time-entries/$NEW_ID/events"

echo
echo "── audit trail for the entry this run created ──"
"$PSQL" -U postgres -h localhost -p 5432 -d timetracker -c \
 "SELECT e.action, u.name AS actor FROM time_entry_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.time_entry_id=$NEW_ID ORDER BY e.id;"

# clean up the entry this run created
"$PSQL" $DB "BEGIN; SELECT set_config('app.actor_id','1',true); DELETE FROM time_entries WHERE id=$NEW_ID; COMMIT;" >/dev/null 2>&1

echo "  ── $PASS passed, $FAIL failed ──"
rm -f /tmp/analyst.txt /tmp/assoc.txt /tmp/md.txt /tmp/_body
[ "$FAIL" -eq 0 ]
