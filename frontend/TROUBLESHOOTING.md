> **Note (v15):** the AI, passcode and data settings now live in the Python backend (`../backend/.env`), not in this folder's `.env.local`. Where this page says `.env.local` for those, use `backend/.env`. See `../SETUP-GUIDE.md`.

# Troubleshooting

## "I could not read that file" / a PDF will not upload
1. **Run `npm install` once after updating.** It installs the scanned-PDF reader and copies it into `public/ocr` (about 13 MB). Then restart the app.
2. **Scanned PDFs and “Microsoft Print to PDF” files are supported.** Some PDFs have no text inside, only pictures of pages (a scan, a phone photo, or a page printed with *Microsoft Print to PDF*). ProofLearn now reads these like a photo (OCR) **inside the browser**. It takes about 5 seconds a page, shows “Reading page 2 of 6”, and nothing is uploaded.
3. **Tip:** when you print a page from Chrome or Edge, choose **Save as PDF** as the destination (not *Microsoft Print to PDF*). Then the text stays real, and reading is instant and more accurate.
4. Limits: 30 pages, English text for scans. A **password-protected** PDF must be saved again without the password. A **damaged** PDF must be exported again from the program that made it.
5. For other languages, add the language file (for example `@tesseract.js-data/afr`) to `scripts/copy-ocr-assets.mjs` and change `"eng"` in `lib/ocr.ts`.

## "The AI is busy" / "needs a short rest" / "daily free allowance"
**Why it happens.** Groq limits how many *tokens* (pieces of text) each model can read and write per minute, for your whole account. The **Teacher planning room** makes four AI requests in a row (build the course, draft the test, check the test, write the lesson plan), and each one used to re-send the whole course and your whole notes file. That was roughly 15,000-20,000 tokens in one minute, against a free allowance of about 8,000. So the last step got refused.

**What the app does now (nothing for you to do):**
- **Sends much less.** Lessons are sent in a short form, and long notes are cut down to the parts that match the topic.
- **Caps answer length** so the AI does not reserve more allowance than it needs, and thinks less (`GROQ_REASONING=low`).
- **Keeps count of the minute's allowance** (`lib/llm.ts`). If the main model is nearly used up, the step goes to another model that has room (`GROQ_FALLBACK_MODELS`; the default list includes models with bigger allowances), or waits for its turn.
- **The page waits and retries by itself.** You see “The AI needs a short rest… carrying on by itself in 45 seconds”. Do not press the button again; the work continues and the lesson plan appears.
- When something really is wrong, it says what: the key, the model name, a daily allowance, or a timeout.

**Still slow on the free plan?** With only one free model the planning room can take about 3 minutes, because it needs more text than the model may read per minute. Options, best first:
1. Leave the fallback models switched on (the default). Planning then usually takes under a minute.
2. Upgrade the Groq plan (console.groq.com): the limits become much higher.
3. Use fewer, shorter notes in the planning room, and a shorter lesson time.

**“…daily free allowance”**: it comes back by itself (the message says when). To carry on now, set another model in `.env.local` (for example `GROQ_MODEL=llama-3.3-70b-versatile`) or upgrade the plan.

**To see exactly what is sent:** add `LLM_DEBUG=1` to `.env.local` and restart. The terminal prints the size of each request. Lines starting with `[groq]` show the reason when Groq refuses one.

## The teacher cannot edit an old test
The secret teacher key is stored in the browser that created it. Use the same browser and do not clear its data.
