# ProofLearn: frontend (Next.js)

This folder is only the **screens**. All the thinking (AI calls, marking, saving shared notes and tests, reading PDF/Word files) now happens in the Python backend in `../backend`.

Start here: **`../SETUP-GUIDE.md`** (step by step, for Windows, Mac and Linux).

Quick version, with the backend already running on port 8000:

    npm install
    copy .env.example .env.local      (Mac/Linux: cp .env.example .env.local)
    npm run dev                       then open http://localhost:3000

How it connects: `next.config.mjs` has a rewrite that sends every `/api/...` request to `BACKEND_URL` (default `http://127.0.0.1:8000`).
The browser never talks to Python directly.

For learners and teachers (not programmers): `USER-GUIDE.md`.
