#!/bin/bash
# usage: tests/run.sh smoke.sh | work.sh | abuse.sh | big.sh | "python3 share.py"   (extra args are env vars, e.g. TEACHER_PASSCODE=letmein-2026)
# Starts a FAKE AI (tests/mock-groq.js, needs Node.js) and this backend on port 3100, runs one test script, then stops both. Costs nothing.
HERE="$(cd "$(dirname "$0")" && pwd)"; APP="$HERE/.."
PY="${PYTHON:-python3}"; [ -x "$APP/venv/bin/python" ] && PY="$APP/venv/bin/python"
# make sure nothing from an earlier run is still listening
pkill -f "uvicorn app.main:app --port 3100" 2>/dev/null; pkill -f "mock-groq.js" 2>/dev/null
for i in $(seq 1 20); do curl -s -m 1 localhost:3100/api/health >/dev/null || break; sleep 0.5; done
rm -rf "$HERE/data"
node "$HERE/mock-groq.js" > "$HERE/mock.log" 2>&1 & MOCK=$!
( cd "$APP" && env GROQ_API_KEY=gsk_testtesttesttesttest GROQ_BASE_URL=http://localhost:4010 APP_SECRET=testsecret DATA_DIR="$HERE/data" ALLOWED_ORIGINS=http://localhost:3100 "${@:2}" "$PY" -m uvicorn app.main:app --port 3100 > "$HERE/server.log" 2>&1 ) & SRV=$!
for i in $(seq 1 40); do curl -s -m 2 localhost:3100/api/notes >/dev/null && break; sleep 1; done
( cd "$HERE" && if [[ "$1" == *" "* ]]; then eval "$1"; else bash "$1"; fi )
kill $MOCK $SRV 2>/dev/null; pkill -f "uvicorn app.main:app --port 3100" 2>/dev/null; sleep 1; true
