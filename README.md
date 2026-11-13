# ProofLearn

**An AI study platform with two autonomous agents: a teacher's digital colleague and a learner's personal coach — built so the humans stay in control.**

ProofLearn turns notes into lessons, tests and coaching. A teacher types one goal ("photosynthesis, five lessons, a test, share it with my class") and an autonomous colleague plans and does the work, step by step, inside strict server-enforced guardrails. A learner gets a coach that builds tests from *their own* notes and only accepts a topic as learned when they score 70%+ on questions the server marked.

---

## Why it exists

- **Teachers lose hours every week** to lesson planning, test writing, quality-checking, marking and reporting.
- **Learners drown in notes** with no fast way to test themselves, ask questions against their own material, or know what to revise next.
- **Schools can't trust plain chatbots** — no guardrails, no audit trail, no quality control.

ProofLearn's answer: agents that *do the workflow*, not just answer questions — with the rules enforced in code, not by the model.

## What's inside

### For teachers
- **Notes for my class** — write, paste, or upload PDF/Word; the AI helper drafts, fixes, summarises or rewrites (it only suggests — nothing changes until you press *Use this*, and you can undo).
- **Tests and classwork** — AI drafts questions from your note (choice, written, ordering), a strict **checker AI** verifies each one, and **you read and edit every question before it goes out**. Share with a code, link or QR; download/print student and teacher copies.
- **Results** — class average, weak topics, hardest questions (totals only — never learner names or written answers).
- **Lesson plans and 10-minute reteach plans.**
- **The digital colleague** (autonomous agent) — type a goal; it works as a small team and reports back.

### For learners
- **My notes** — type, paste, upload PDF/Word, or start a draft with AI.
- **Test myself** — AI writes questions from *your* note; every question shows the exact passage it came from.
- **Ask my notes** — answers grounded in your note, with the source shown; if your note doesn't say, it says so.
- **The coach** (autonomous agent) — teaches one topic at a time, quizzes you, and only calls a topic *learned* at 70%+ on server-marked questions.

### The two autonomous agents

The AI never executes anything directly. Each step, the model is shown the goal and everything that has happened so far, and it **chooses the next tool**; the server checks that choice against a fixed rulebook (`backend/app/colleague_rules.py`, `coach_rules.py`) — which tools exist, which are allowed right now, how often each may be used — and only then does the tool run through the normal, already-validated endpoints. If the model picks something unusable, it gets one correction; if it still fails, the server takes a safe default and says so openly.

**The colleague's team** (one decision loop, presented in the UI as agent lanes):

| Agent | What it does |
|---|---|
| Coordinator | Turns the goal into a plan and chooses each next step |
| Researcher | Searches the teacher's notes and (optionally) the web |
| Writer | Builds lessons, writes questions, plans lessons, drafts emails |
| Checker | A strict second AI that fixes/removes any question it cannot support — a hard gate before sharing |
| Publisher | Shares the finished test via code/link/QR — **only with prior teacher opt-in, and only for a test that just passed the checker with zero changes** |
| Messenger | Reads result totals and drafts emails — **never sends anything** |

**The coach's loop** is the same pattern with learner tools: `build_lessons → teach_topic → quiz → mark`, stopping when every topic is proven or it has taught a topic three times.

## Quick start

You run **two programs** (see [SETUP-GUIDE.md](SETUP-GUIDE.md) for the full step-by-step, Windows/Mac/Linux):

```bash
# Terminal 1 — backend (Python 3.10+, FastAPI) on http://127.0.0.1:8000
cd backend
python -m venv venv && source venv/bin/activate   # Windows: venv\Scriptsctivate
pip install -r requirements.txt
cp .env.example .env                              # add GROQ_API_KEY and APP_SECRET
python -m uvicorn app.main:app --reload --port 8000

# Terminal 2 — frontend (Node 18.17+, Next.js) on http://localhost:3000
cd frontend
npm install
cp .env.example .env.local
npm run dev
```

You need a free [Groq API key](https://console.groq.com/keys). Optional: a [Tavily key](https://app.tavily.com) for the colleague's web search.

## Repository layout

```
prooflearn-v15/
  SETUP-GUIDE.md    step-by-step setup for Windows, Mac and Linux
  backend/          Python (FastAPI): all AI calls, marking, safety, storage
    app/routes/     one file per API area (notes, work, study, agent, assist, extract, search, colleague, coach)
    app/colleague_rules.py, coach_rules.py   the tool catalogues + safety rules for the agents
    tests/          free tests against a fake AI (no key needed)
  frontend/         Next.js: the screens for learners and teachers
    components/     Colleague.tsx (agent lanes view), Coach.tsx, WorkStudio.tsx, NotesLab.tsx, ...
    lib/            agent run loop (runAgents.ts), tool catalogues kept in step with the backend
```

Every `/api/...` request from the browser is proxied by Next.js to the backend (`rewrites` in `frontend/next.config.mjs`); the browser never talks to Python directly.

## How the agent loop works

1. The human sets a goal and presses Start (they can press Stop at any time).
2. Each step, the browser sends the goal plus a snapshot of state and the history of what happened to `/api/colleague` (or `/api/coach`).
3. The server computes which tools are **offered right now** from the state (e.g. `share_test` is only offered after a clean checker pass) and prompts the model: *choose ONE tool; decide the order yourself; skip what the goal doesn't need; repeat or reroute when something fails.*
4. The model returns `thought / action / args / plan`; the server validates it against the rules, corrects once, falls back to a safe default if needed.
5. The tool runs; its result feeds back into the next step; repeat until `finish`, the step cap, or no tools remain.

The result: genuine decide-at-runtime autonomy — bounded by hard step caps, per-tool use limits, rate limits, prompt-injection fences, and human approval gates on anything that leaves the classroom.

## Safety and privacy (the design centre)

- **Server-enforced rules.** The AI proposes, the code disposes. Tool catalogues, per-tool limits and blocked-conditions live in `colleague_rules.py` / `coach_rules.py` and are re-checked on every call.
- **Human approval gates.** Sharing a test requires an explicit opt-in before the run and a zero-change checker pass; emails are drafts only.
- **Learner privacy.** Agents see result totals only — never names or written answers. Learners are asked to use nicknames.
- **Input hygiene.** Rate limits, same-site checks, prompt-injection fences, strict validation of everything the model returns, signed answer keys.
- **No silent changes.** The AI helper only suggests; the human confirms.

## Tech stack

- **Frontend:** Next.js (React, TypeScript)
- **Backend:** Python, FastAPI; Groq LLMs (configurable model + fallbacks, token budget)
- **RAG:** BM25 passage ranking over the learner's/teacher's own notes; OCR (Tesseract) for scanned past papers
- **Search:** Tavily (optional, for the colleague)
- **Storage:** JSON files in `backend/.data/` (swap for a real database — see roadmap)
- **Tests:** free test scripts against a fake AI (`backend/tests/`), no API key needed

## Running the tests (no API key needed)

```bash
cd backend
bash tests/run.sh smoke.sh
bash tests/run.sh work.sh
bash tests/run.sh abuse.sh TEACHER_PASSCODE=letmein-2026
bash tests/run.sh "python3 api_agent.py" RATE_LIMIT_AGENT_PER_MIN=300 RATE_LIMIT_PER_MIN=300
```

## Roadmap (in build order)

1. **Accounts + database** (Supabase) — work on any device, verified learners, class lists
2. **Redis rate limiting** (Upstash) — limits that survive restarts and multiple servers
3. **Email/WhatsApp results** to teachers (with a human "Send" click)
4. **Scanned papers (OCR)** — photos of past papers become notes
5. **Embedding-based search** added to BM25 — find passages by meaning, not only words
6. **POPIA privacy notice, data deletion and retention**
7. **Deploy** — one URL for everyone

## Going to production

Run with `APP_ENV=production`, a real `APP_SECRET` and `TEACHER_PASSCODE`, behind your host's process manager
(`uvicorn app.main:app --host 127.0.0.1 --port 8000` without `--reload`), set `BACKEND_URL` in the frontend,
and configure `ALLOWED_ORIGINS` for your domain.

---

*ProofLearn: the agent does the work — the human keeps the keys.*
