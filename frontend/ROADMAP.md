# ProofLearn: what is next, in build order

Done in v4: shared notes and tests with codes, teacher editing, answers kept on the server, RAG with source passages, rate limits and input checks, learner notes (upload, edit, Word/PDF), results for teachers, plain-language screens, tests.

| # | Next | Why it matters | Effort |
|---|---|---|---|
| 1 | Accounts and database (Supabase Auth + `supabase/schema.sql`, swap `lib/store.ts`) | Teachers keep their work on any device; verified learners; class lists; works on Vercel | 1-2 days |
| 2 | Redis rate limiting (Upstash) | Limits survive restarts and many servers | 2 h |
| 3 | Email or WhatsApp results to teacher (human "Send" click) | Teachers hear about results without logging in | 3 h |
| 4 | Scanned papers (OCR) | Photos of past papers become notes | 3 h |
| 5 | Embedding-based search added to BM25 | Finds passages by meaning, not only words | 1 day |
| 6 | Privacy notice, data deletion and retention for POPIA | Needed before real classes | 1 day |
| 7 | Deploy | One URL for everyone; set env vars there | 1 h |
