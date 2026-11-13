#!/bin/bash
H='content-type: application/json'
O='origin: http://localhost:3100'
post() { curl -s -X POST localhost:3100/api/$1 -H "$H" -H "$O" ${3:+-H "$3"} -d "$2"; echo; }
NOTES='Photosynthesis is how plants make food. Plants take in water through roots and carbon dioxide through leaves. Light hits the leaf and the plant makes sugar and oxygen.\n\nChlorophyll is the green pigment that captures light energy inside the chloroplast.'

echo "== 1. teacher creates + shares a note"
R=$(post notes '{"action":"create","title":"Plants","body":"'"$NOTES"'"}'); echo $R
NCODE=$(echo $R | python3 -c "import sys,json;print(json.load(sys.stdin)['code'])"); NKEY=$(echo $R | python3 -c "import sys,json;print(json.load(sys.stdin)['editKey'])")
echo "== 2. learner opens it by code (lowercase, no dash)"; post notes '{"action":"get","code":"'$(echo $NCODE | tr 'A-Z' 'a-z' | tr -d '-')'"}'
echo "== 3. wrong code"; post notes '{"action":"get","code":"NZZZ-ZZZZ"}'
echo "== 4. update with WRONG key"; post notes '{"action":"update","code":"'$NCODE'","editKey":"wrongwrongwrongwrongwrong","title":"x","body":"'"$NOTES"'"}'
echo "== 5. update with right key"; post notes '{"action":"update","code":"'$NCODE'","editKey":"'$NKEY'","title":"Plants v2","body":"'"$NOTES"'"}'
echo "== 6. path traversal code"; post notes '{"action":"get","code":"../../etc/passwd"}'
echo "== 7. cross-site origin refused"; curl -s -X POST localhost:3100/api/notes -H "$H" -H 'origin: https://evil.example' -d '{"action":"get","code":"'$NCODE'"}'; echo
echo "== 8. too-large title"; post notes '{"action":"create","title":"'$(python3 -c "print('a'*500)")'","body":"'"$NOTES"'"}'
echo "== 9. AI: draft test from notes (learner, RAG + checker)"; post study '{"action":"test","notes":"'"$NOTES"'","count":4}' | python3 -c "
import sys,json;d=json.load(sys.stdin);print('checked',d.get('checked'));print([ (q['id'],q['kind'],q['topic'],bool(q.get('ref')),bool(q.get('sig'))) for q in d['questions']]);print([ (f['id'],f['action']) for f in d['findings']])"
echo "== 10. AI: ask the notes"; post study '{"action":"ask","notes":"'"$NOTES"'","question":"What do plants make?"}'
echo "== 11. AI: teacher draft"; post study '{"action":"test","forTeacher":true,"notes":"'"$NOTES"'","count":4}' | python3 -c "
import sys,json;d=json.load(sys.stdin);print([ (q['id'],q['kind'],q.get('answer')) for q in d['questions']])"
