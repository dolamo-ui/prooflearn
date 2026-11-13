# ProofLearn: a simple guide

No technical knowledge needed. Open the app and press the big buttons. Each screen tells you what to do next.

## If you are a learner

1. **My notes.** Press *New note* and type or paste your notes. Not sure what to write? Press *Write a note with AI*, or open the **✨ AI helper** under any note: it can write a first draft, fix your spelling, organise your notes with headings, make them shorter or simpler, continue writing, and add examples or key words. **It only suggests. Nothing changes until you press “Use this”, and you can undo.** Always check the facts. Or press *Upload a PDF or Word file* and the text becomes a note you can change. Everything saves by itself.
2. **Test myself.** Choose a note. Leave *How many questions?* on **Automatic** (a short note gets a few questions, a long note gets many, up to 100) or choose your own number. Press *Make my test*. The AI writes questions from *your* note and double-checks them. After you answer, every question shows the part of your note it came from.
3. **Ask my notes.** Type a question. The AI answers only from your note and shows where. If your note does not say, it tells you.
4. **Open my teacher's work.** Type the code your teacher gave you (like `NABC-D234`). Notes can be saved to your notes. Tests can be done online. Use a nickname, not your full name.
5. **Learn something new.** Tell the AI a topic and get short lessons and a test.

**Keep your work safe:** notes live on *this device*. Use *Download as Word* for anything important.

## If you are a teacher

1. **Notes for my class.** Write, paste or upload notes, or press *Write a note with AI* and describe your lesson. The **✨ AI helper** can also add learning objectives, a summary and worked examples, or rewrite your text for a chosen audience (primary, high school, university, adults). Press *Share this note* to get a code. Press *Update the shared copy* after you change it.
2. **Tests and classwork.** Press *Create a new one*, then:
   - Step 1: name it and choose test, classwork, homework…
   - Step 2: choose a note (or upload a PDF or Word file), pick **how many questions** (Automatic suggests a number from the length of the text, or choose up to 100), and press *Draft questions with AI*. Long tests take about 20 seconds per 10 questions, and you can press Stop.
   - Step 3: **read every question and fix anything you like.** Choose the correct answer yourself.
   - Step 4: *Save and get code*. Give the code to learners.
3. **Download or print.** In the test editor (or press *Download / Print* in your list) choose **Student copy** (no answers, with a name line and writing space) or **Teacher copy** (with the memo), then *Download PDF*, *Download Word* or *Print*.
4. **Results.** Open *Results* on any test to see the class average, the topics to teach again, and which questions were hardest.
5. **Plan a lesson and reteach.** Lesson plans and 10-minute reteach plans.
6. **Digital colleague.** Type a goal and press *Start*. It can build lessons, write and check a test, and plan the lesson. Three extras need your say-so or only produce drafts:
   - **Share the test:** tick *Let my colleague share the finished test with learners* before you press Start. It will only share a test that the checker passed with no changes, and you get the code, link and QR code in the report. Leave it unticked and nothing is published.
   - **Read the results:** it can read the class average and the topics to teach again for tests you shared from this browser. It sees totals only, never learner names or written answers.
   - **Email draft:** it writes an email to learners, parents or colleagues. **It never sends anything.** Read it, fill in the [ ] gaps, then copy it or open it in your own email app.
   - **The team:** your colleague works as a small team (Researcher, Writer, Checker, Publisher, Messenger) under a Coordinator. While it works you can watch it in *Agent lanes* (one column per team member) or *One list*. The report has a **Who did what** section that says what each one made and what they handed to each other. It also says when the Checker sent work back.

**Important for teachers**
- Use the **same browser** each time. Your secret teacher key is stored in it. If you clear browser data you can no longer edit those items.
- The AI can make mistakes. Always read the questions before sharing. A question that almost everyone gets wrong may itself be wrong.
- Turn off *Show learners the correct answers* for exams.
- Do not enter real learner names or marks. Learners use nicknames.

**Sharing a test, classwork or homework:** after you press “Save and get link” you see a QR code, a link and a code. Show the QR on the board, paste the link in your class chat, or press WhatsApp. Learners need no account. You can open this again any time from your list with “Link / QR”.

## If you are the person setting it up
See `README.md`. The three things that matter: add the Groq key, add `APP_SECRET`, and add `TEACHER_PASSCODE`.

## If something goes wrong
- **My PDF will not upload.** Scans and “Microsoft Print to PDF” files are read like a photo. You will see “Reading page 2 of 6”. Wait for it. Tip: print with **Save as PDF** instead, so the text stays real. Password-protected files need the password removed first.
- **“The AI is busy”.** The AI service has a small allowance per minute and per day. Wait the time the message says, then press the button once. More in `TROUBLESHOOTING.md`.
