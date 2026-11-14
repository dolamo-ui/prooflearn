# ProofLearn Digital Colleague

> **Teach me anything. Prove I learned it.**

ProofLearn is an autonomous education colleague. Give it a goal and it decides what to teach, writes the lessons and tests, has a second AI check its own work, fixes what fails, and only says a learner has learned something when their **marked answers** prove it.

Built for **Colleague Zero 2026** (Melsoft Academy).

| | |
|---|---|
| **Live demo** | `https://prooflearn-agent.vercel.app/` |
| **Demo without AI or Wi-Fi** | `/demo` page in the app |
| **Repo** | `https://github.com/dolamo-ui/prooflearn` |

---

## The problem

When someone says "teach me Excel", nobody can tell whether they really learned it or just clicked through. Teachers spend hours writing tests from memos and past papers, and then do not know which topics to teach again.

## What it does

**For learners** (no account needed)

- **My learning coach**: type what you want to learn. The coach decides when to teach, when to test you, and when to re-teach in a different way. It stops only when your marked scores prove the learning.
- Paste or upload notes (PDF, Word, even scanned PDFs through in-browser OCR), then test yourself from them. Every answer shows the passage in your notes it came from.
- Ask your notes questions, and open a teacher's test with a code, link or QR code.

**For teachers**

- **Digital colleague**: give a goal such as "make a lesson and a test on photosynthesis from my notes and share it". The colleague plans, picks its own tools, and reports back with what it made and what to double-check.
- Upload a memo or past paper. The AI drafts questions, a checker AI removes or fixes weak ones, and you edit them in a notebook-style editor.
- Share by code, link or QR. See class average, topics to teach again and the hardest question.
- Download tests as PDF or Word.

## How it is autonomous (and how it corrects itself)

The AI chooses the **next step**; the code enforces the **rules**.

```
Goal ──> Coordinator decides the next step
          ├─ Researcher   searches the notes and the web (read-only)
          ├─ Writer       lessons and lesson plan
          ├─ Quality loop (Google ADK LoopAgent)
          │     writer_qa  ──write questions──>  checker  ──fixes / removes bad ones──┐
          │         ▲_________________ repeat until a check passes with no changes ____│
          ├─ Publisher    shares a checked test, reads results (runs on the teacher's device)
          └─ Messenger    drafts emails (never sends)
```

**Self-correction:** a test cannot be shared until the checker passes it with *zero* fixes and *zero* removals. If the checker changes anything, the loop runs again (up to 3 rounds).

**Tools the colleague can use:** `search_notes`, `web_search` (Tavily), `build_lessons`, `write_questions`, `check_questions`, `plan_lesson`, `share_test`, `read_results`, `draft_email`, `finish`.

**Two engines, one screen:** *Classic* (a loop in the browser) and *Agent team* (separate agents built with [Google ADK](https://adk.dev/)).

## Safety and trust

- **Human in the loop:** emails are drafts only. Nothing is sent or shared without the teacher.
- **Rules in code, not just prompts:** each tool has preconditions and usage limits (for example, `share_test` only works after a clean check). The run has a step limit.
- **Answers never reach the learner's browser before hand-in.** Marking happens on the server, and self-test keys are signed (HMAC).
- **Prompt-injection defence:** untrusted text is cleaned and fenced as data. A written answer that tries to give the marker orders is marked wrong without asking the AI. AI output is validated in code.
- **Rate limits, same-site checks, strict input validation, file-type checks and a content security policy.**
- **Secrets stay on the backend** and are scrubbed from AI replies.

Details and honest gaps: [`frontend/SECURITY.md`](frontend/SECURITY.md).

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14, React 18, TypeScript |
| Backend | Python, FastAPI |
| AI | Groq (`openai/gpt-oss-120b` by default), Google Agent Development Kit (ADK), optional Gemini or any LiteLLM model |
| Search | Tavily (optional) |
| Files | `pypdf`, `python-docx`, in-browser OCR (Tesseract.js), `jspdf` |
| Storage | JSON files in `backend/.data/` (prototype; see limits below) |

```
backend/    Python (FastAPI): the AI, marking, saving, reading PDF/Word   -> http://127.0.0.1:8000
frontend/   Next.js: the screens learners and teachers see                -> http://localhost:3000
```

The browser only talks to the frontend; Next.js forwards `/api/...` to the backend.

## Run it locally

**You need:** Python 3.10+, Node.js 18.17+, and a free [Groq key](https://console.groq.com/keys). A [Tavily key](https://app.tavily.com) is optional (web search).

**1. Backend** (Terminal 1)

```bash
cd backend
python -m venv venv
# Windows: venv\Scripts\activate      Mac/Linux: source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # Windows: copy .env.example .env
```

Edit `.env`:

```
GROQ_API_KEY=gsk_...
APP_SECRET=<run: python -c "import secrets; print(secrets.token_hex(32))">
TEACHER_PASSCODE=<optional, recommended once others can reach the app>
TAVILY_API_KEY=<optional>
```

```bash
python -m uvicorn app.main:app --reload --port 8000
```

Check <http://127.0.0.1:8000/api/health>, which should show `{"ok":true}`. (`run.bat` or `bash run.sh` does all of this for you.)

**2. Frontend** (Terminal 2)

```bash
cd frontend
npm install
cp .env.example .env.local      # Windows: copy .env.example .env.local
npm run dev
```

Open <http://localhost:3000>. The green **"AI is on"** badge means the frontend reached the backend and the Groq key works.

More help: [`SETUP-GUIDE.md`](SETUP-GUIDE.md), [`frontend/TROUBLESHOOTING.md`](frontend/TROUBLESHOOTING.md), [`frontend/USER-GUIDE.md`](frontend/USER-GUIDE.md).

### Try the golden path (about 3 minutes)

1. **Teacher** → *Digital colleague* → choose **Agent team** → goal: *"Make a short lesson and a test from my notes and share it."* Watch the agents hand off, the checker catch problems, and the loop re-check.
2. Open the shared **test code** in a private window as a **learner** and hand it in.
3. Back as the teacher, open **See results**: class average, topics to teach again, hardest question.
4. **Learner** → *My learning coach* → type a goal and watch it teach, test, and re-teach until the marks prove it.

Full demo script: [`frontend/DEMO.md`](frontend/DEMO.md).

## Tests

Free tests run against a fake AI (no keys needed):

```bash
cd backend
bash tests/run.sh smoke.sh
bash tests/run.sh work.sh
python tests/adk_team.py        # delegation, the checker loop, rules and limits
```

See [`backend/README.md`](backend/README.md) for the full list.

## Deploying

Frontend on Vercel or your own server, backend on a host with a persistent disk (Railway, Render, a VPS). Set `BACKEND_URL` on the frontend; set `ALLOWED_ORIGINS`, `APP_ENV=production`, a real `APP_SECRET` and `TEACHER_PASSCODE` on the backend. Never commit `.env` files.

## Honest limits

- **No accounts yet.** Teachers are identified by a secret key in their browser; learners join with a code. Not for high-stakes exams.
- **Storage is files on one server**, and agent run state is in memory. Next step: Supabase (auth and database) and Redis.
- **AI marking of written answers can be wrong.** Teachers can read written answers in Results.
- **Privacy (POPIA):** text sent to an AI button goes to the model provider. Add a privacy notice and avoid real names before using with a class.
- A team run makes more AI calls than Classic, so on Groq's free plan it may wait for the per-minute allowance.

Roadmap: [`frontend/ROADMAP.md`](frontend/ROADMAP.md).

## Author

**Nyakallo Dolamo**, junior full-stack and mobile developer, Gauteng, South Africa. [github.com/dolamo-ui](https://github.com/dolamo-ui)
