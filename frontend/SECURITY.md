# ProofLearn security notes

## What is protected

| Risk | Protection | Where |
|---|---|---|
| Strangers burn your AI quota | Rate limits by job (AI 8/min and 80/hour per visitor, plus a global hourly cap). Optional `TEACHER_PASSCODE` for creating shared items and drafting. | `lib/security.ts` |
| Someone keeps hammering | 3 limit hits in 10 minutes gives a 10-minute time-out on **every** route. Counters are shared across routes. | `lib/security.ts` |
| Guessing share codes or the passcode | Separate, stricter limits for code lookups (20/min) and passcode tries (6/min). Codes have about 34 billion possibilities. Wrong codes all give the same message. | `lib/security.ts` |
| Other websites making a visitor's browser call us (CSRF) | Same-site check on every POST | `sameOrigin()` |
| Spoofed visitor address to dodge limits | Address is read from the proxy's side of `x-forwarded-for` (`TRUSTED_PROXY_HOPS`) | `clientIp()` |
| Bad or huge input | Every field checked for type, length and allowed values. Body cap 300 KB, notes 20,000 characters, 100 questions, 300 submissions per test, 5,000 shared items. Friendly error, never a crash. | `lib/input.ts`, `readJson()` |
| Reaching other files through a code | Codes must match a strict pattern before any file is touched | `lib/store.ts` |
| Prompt injection (notes, questions, written answers) | Untrusted text is cleaned, fenced in a random boundary, and the AI is told it is data. A written answer that looks like an order to the marker is marked wrong without asking the AI. AI output is validated and shaped in code. | `fence()`, `lib/grading.ts` |
| Secrets leaking in an AI reply | Known secrets are removed from AI text before it is returned | `scrub()` |
| Learner cheats by reading answers | Teacher tests are stored on the server. Learners receive questions **without** answers; marking happens on the server. | `app/api/work` |
| Learner edits a self-test key | Written-answer keys are signed (HMAC); a changed key is refused | `signKey()` |
| Anyone editing someone else's note or test | Editing needs a secret teacher key. Only its hash is stored, compared in constant time. | `keyOk()` |
| Stored text running as code (XSS) | Everything is plain text, shown by React and escaped in downloads. CSP blocks other scripts. | `components/*`, `next.config.mjs` |
| AI helper changing notes by itself | It only returns text; the person must press “Use this”; one-step undo. Output is cleaned to plain text, secrets removed, text sent to it is fenced as data. | `app/api/assist` |
| Giant tests used as an attack | Max 100 questions, written in batches of 10 (each batch is one rate-limited request). Only wrong passcode tries count against the passcode limit. | `lib/sizing.ts`, `requireTeacher()` |
| Scanned-PDF reader | Runs in the browser from our own files (`/ocr`); no third-party scripts. The page policy allows WebAssembly (`wasm-unsafe-eval`) and same-site workers only. 30-page limit. | `lib/ocr.ts`, `next.config.mjs` |
| Raw errors shown | Only safe messages are returned; details stay in the server log | all routes |
| Uploaded files | Real PDF/Word header check, 4 MB, 30 pages, 20 s timeout, text only | `app/api/extract` |

## Still open (be honest about these)

1. **No accounts.** Teachers are identified by a secret key in their browser. Clear the browser data and you lose the ability to edit (learners are not affected). Real login (Supabase Auth) is the next step.
2. **Anyone with a test code can hand in**, and nicknames are not verified. Cap of 300 per test; close the test to stop it. Not suitable for high-stakes exams.
3. **Prompt injection can never be fully removed.** The AI has no power beyond writing text, and a teacher reads questions before sharing. AI marking of written answers can be wrong or fooled by clever wording; teachers can read the written answers in Results.
4. **Storage is files on one server.** Not for serverless hosting, and no backups unless you make them. Swap `lib/store.ts` for Supabase.
5. **Rate limits are in memory.** They reset on restart and are not shared across several servers. Use Upstash Redis for that.
6. **Privacy (POPIA).** The text a person sends to an AI button goes to Groq. Learner nicknames and written answers are stored on your server. Many learners are minors: add a privacy notice and avoid real names before using with a class.
7. **Virus scanning** of uploaded Word files is not included (low risk at 4 MB; add a scan before real use).
8. **Next.js advisories.** `npm audit` lists some with no 14.x fix, for features this app does not use. Move to the latest Next major and test.

## Rules when you add agent tools
- One job per tool, arguments checked in code.
- Human approval before anything leaves the app (emails, marks).
- Log every agent action.
- Never put secrets, answer keys or other learners' data in a prompt.
