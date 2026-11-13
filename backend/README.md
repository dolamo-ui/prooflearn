# ProofLearn backend (Python / FastAPI)

The brain of ProofLearn. The Next.js app in `../frontend` shows the screens; this server does the work:

| Endpoint | What it does |
|---|---|
| `GET/POST /api/notes` | Shared notes (share code + secret teacher key) |
| `POST /api/work` | Teacher tests: create, share, learners hand in, marking, results |
| `POST /api/study` | Tests from notes (RAG + a second "checker" AI pass), ask-my-notes, marking written answers |
| `GET/POST /api/agent` | Courses, lessons, voice tutor, lesson plans, reteach plans, test drafting/checking/marking |
| `POST /api/assist` | The AI helper inside the notes editor |
| `POST /api/extract` | Reads text out of PDF and Word (.docx) files |
| `POST /api/search` | Web search for the digital colleague (Tavily) |
| `POST /api/colleague` | The teacher's autonomous digital colleague: chooses the next tool |
| `POST /api/coach` | The learner's autonomous coach: chooses the next step |
| `GET /api/health` | `{"ok": true}` |

Start it: see `../SETUP-GUIDE.md`. Short version: `run.bat` (Windows) or `bash run.sh` (Mac/Linux). It listens on <http://127.0.0.1:8000>.
While it runs (and `APP_ENV` is not `production`), <http://127.0.0.1:8000/docs> lists every endpoint.

## Code map

    app/main.py            starts FastAPI, error handling, registers the routes
    app/routes/*.py        one file per endpoint above
    app/llm.py             talks to Groq: token budget, waiting, model fallback, friendly errors
    app/security.py        rate limits, same-site check, prompt-injection fences, signed answer keys, share codes
    app/validate.py        strict cleaning of everything the AI returns
    app/store.py           saves shared notes/tests as JSON files in .data/ (swap for a real database later)
    app/rag.py             cuts notes into passages and ranks them (BM25)
    app/colleague_rules.py, coach_rules.py   the tools each autonomous agent may use, and the safety rules
    tests/                 free tests against a fake AI (see below)

## Tests (free, no key needed; Node.js is only used for the fake AI)

    bash tests/run.sh smoke.sh
    bash tests/run.sh work.sh
    bash tests/run.sh abuse.sh TEACHER_PASSCODE=letmein-2026
    bash tests/run.sh big.sh RATE_LIMIT_PER_MIN=100
    bash tests/run.sh "python3 api_agent.py" RATE_LIMIT_PER_MIN=300
    bash tests/run.sh "python3 api_extra.py" TAVILY_API_KEY=tvly-test TAVILY_BASE_URL=http://localhost:4010 RATE_LIMIT_AGENT_PER_MIN=300 RATE_LIMIT_PER_MIN=300

## Adding a tool to the colleague or coach
Add it to the catalogue in `app/colleague_rules.py` (or `coach_rules.py`) **and** in the frontend (`frontend/lib/colleague.ts`, plus its runner in `components/Colleague.tsx`). The AI sees new tools automatically.

## Going online
Run with `APP_ENV=production`, a real `APP_SECRET` and `TEACHER_PASSCODE`, and `uvicorn app.main:app --host 127.0.0.1 --port 8000` (without `--reload`) behind your host's process manager.
Set `BACKEND_URL` in the frontend to wherever this runs, and `ALLOWED_ORIGINS` here to your site's address. `.data/` must live on disk that is not wiped on restart.
