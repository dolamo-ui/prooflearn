# ProofLearn demo guide

Golden path (about 3 minutes): **teacher shares, learner tests, teacher sees results.**

1. **Problem (20s).** "Teachers spend hours writing tests. Learners cannot easily check what they know."
2. **Teacher notes (30s).** Home, I am a teacher, Notes for my class. Upload a PDF or Word memo (or paste text). Press *Share this note*. Read out the code.
3. **AI drafts, teacher edits (50s).** Press *Make a test or classwork*, then *Draft questions with AI*. Point at "the AI double-checked them and removed 1 weak one". Edit one question. *Save and get code*.
4. **Learner (50s).** Open a private window (a different learner). Type the test code on the home page. Answer badly on purpose, hand in. Show the explanation. Then open the **note code**, *Save to my notes and test myself*, and point at **"From your note:"** under each answer (RAG).
5. **Teacher results (20s).** *See results*: class average, topics to teach again, hardest question.
6. **Security (10s).** Mention: answers never reach the learner's browser before they hand in; rate limits; teacher passcode.

## Safe demo checklist
- [ ] Groq key, `APP_SECRET` and `TEACHER_PASSCODE` set in `.env.local`; `npm run dev` works.
- [ ] Run the whole path 3 times with your own PDF (text, not a photo; under 4 MB and 30 pages).
- [ ] Record one good run as a backup. `/demo` also works with no AI and no Wi-Fi.
- [ ] Use the same browser for the teacher part. Use a private window for the learner.
- [ ] Charge laptop, close other tabs, have a mobile hotspot ready.

## Honest limits to say out loud
No accounts yet: teachers are identified by a key in their browser. Shared data is saved as files on one server. Next step is Supabase login and storage.
