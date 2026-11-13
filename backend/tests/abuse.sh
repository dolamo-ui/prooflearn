#!/bin/bash
H='content-type: application/json'; O='origin: http://localhost:3100'
post() { curl -s -X POST localhost:3100/api/$1 -H "$H" -H "$O" -d "$2"; echo; }
echo "== passcode required flag"; curl -s localhost:3100/api/notes; echo
echo "== create note WITHOUT passcode"; post notes '{"action":"create","title":"T","body":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
echo "== create note WRONG passcode"; post notes '{"action":"create","passcode":"nope","title":"T","body":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
echo "== create note RIGHT passcode"; post notes '{"action":"create","passcode":"letmein-2026","title":"T","body":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' | cut -c1-40
echo "== AI teacher draft WITHOUT passcode"; post study '{"action":"test","forTeacher":true,"notes":"Plants make sugar from light and water in their leaves every single day.","count":3}'
echo "== learner self-test needs no passcode"; post study '{"action":"test","notes":"Plants make sugar from light and water in their leaves every single day.","count":3}' | cut -c1-60
echo "== oversized body (400 KB) refused"; python3 -c "print('{\"action\":\"get\",\"code\":\"'+'a'*400000+'\"}')" | curl -s -X POST localhost:3100/api/notes -H "$H" -H "$O" -d @-; echo
echo "== notes text over 20k chars refused"; python3 -c "import json;print(json.dumps({'action':'ask','question':'q?q','notes':'x '*15000}))" | curl -s -X POST localhost:3100/api/study -H "$H" -H "$O" -d @-; echo
echo "== not JSON / array / wrong types"; post study 'hello'; post study '[1,2]'; post study '{"action":"ask","notes":123,"question":{"a":1}}'
echo "== passcode guessing is throttled (auth bucket 6/min)"
for i in $(seq 1 9); do curl -s -o /dev/null -w "%{http_code} " -X POST localhost:3100/api/notes -H "$H" -H "$O" -d '{"action":"create","passcode":"guess'$i'","title":"T","body":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'; done; echo
echo "== after repeated strikes the caller gets a time-out on EVERY route"
post study '{"action":"ask","notes":"Plants make sugar from light and water in their leaves every day.","question":"What do they make?"}'
