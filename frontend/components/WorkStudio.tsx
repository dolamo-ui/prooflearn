"use client";
import { useEffect, useRef, useState } from "react";
import type { Question } from "../lib/agent";
import { api, generateQuestions, loadWork, NOTE_MAX, readFileText, saveWork, type Cancel, type LocalNote, type SavedWork } from "../lib/client";
import { docHtml, downloadDocPdf, downloadDocWord, type ExportDoc } from "../lib/export";
import BlockEditor, { blank, fromServer, toServer, type EQ } from "./BlockEditor";
import ShareBox from "./ShareBox";
import { CountPicker, Msg, NotePicker, Page, PasscodeBox, Progress, resolveCount, useConfirm, type CountChoice } from "./ui";

const KINDS: [string, string][] = [["test", "Test"], ["exam", "Exam"], ["classwork", "Classwork"], ["homework", "Homework"], ["assignment", "Assignment"], ["assessment", "Assessment"], ["practice", "Practice test"]];
const kindName = (k: string) => KINDS.find(([v]) => v === k)?.[1] || "Test";

type Results = {
  title: string; count: number; open: boolean; average: number; weakTopics: string[];
  byTopic: { topic: string; pct: number }[]; questions: { id: string; text: string; pct: number }[];
  submissions: { nickname: string; at: number; right: number; total: number; written: { question: string; answer: string; correct: boolean }[] }[];
};

export default function WorkStudio({ passcode, setPasscode, onBack, startNote }: { passcode: string; setPasscode: (v: string) => void; onBack: () => void; startNote?: LocalNote | null }) {
  const confirm = useConfirm();
  const [view, setView] = useState<"list" | "build" | "results">(startNote ? "build" : "list");
  const [mine, setMine] = useState<SavedWork[]>([]);
  const [current, setCurrent] = useState<SavedWork | null>(null);   // set when editing something already shared
  const [title, setTitle] = useState(startNote ? `Questions on ${startNote.title}` : "");
  const [kind, setKind] = useState("classwork");
  const [instructions, setInstructions] = useState("");
  const [showAnswers, setShowAnswers] = useState(true);
  const [isOpen, setIsOpen] = useState(true);
  const [qs, setQs] = useState<EQ[]>([]);
  const [noteId, setNoteId] = useState(startNote?.id || "");
  const [source, setSource] = useState(startNote?.body || "");
  const [focus, setFocus] = useState("");
  const [count, setCount] = useState<CountChoice>("auto");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const cancel = useRef<Cancel>({ stop: false });
  const [copy, setCopy] = useState<"student" | "teacher">("student");
  const [wantExport, setWantExport] = useState(false);
  const [mix, setMix] = useState<"mixed" | "choice" | "written">("mixed");
  const [aiMode, setAiMode] = useState<"notes" | "topic">(startNote ? "notes" : "topic");
  const [topic, setTopic] = useState("");
  const [topicCount, setTopicCount] = useState(10);
  const [audience, setAudience] = useState("High school learners");
  const [sharing, setSharing] = useState<string | null>(null);   // code whose link/QR is open in the list
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState({ error: "", ok: "" });
  const [results, setResults] = useState<Results | null>(null);
  const [shown, setShown] = useState<{ code: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const say = (ok = "", error = "") => setMsg({ ok, error });

  useEffect(() => { setMine(loadWork()); }, []);
  useEffect(() => {
    if (wantExport && view === "build" && qs.length) { document.getElementById("export-panel")?.scrollIntoView({ behavior: "smooth" }); setWantExport(false); }
  }, [wantExport, view, qs.length]);

  const startNew = () => {
    setCurrent(null); setTitle(""); setKind("classwork"); setInstructions(""); setShowAnswers(true); setIsOpen(true);
    setQs([]); setShown(null); say(); setView("build");
  };

  const openExisting = async (w: SavedWork, to: "build" | "results") => {
    setBusy("open"); say();
    try {
      if (to === "results") {
        const r = await api<Results>("/api/work", { action: "results", code: w.code, editKey: w.key });
        setResults(r); setCurrent(w); setIsOpen(r.open);
      } else {
        const r = await api<any>("/api/work", { action: "open", code: w.code, editKey: w.key });
        setCurrent(w); setTitle(r.title); setKind(r.kind); setInstructions(r.instructions); setShowAnswers(r.showAnswers); setIsOpen(r.open);
        setQs((r.questions as Question[]).map(fromServer)); setShown({ code: w.code });
      }
      setView(to);
    } catch (e: any) { say("", e.message); }
    setBusy("");
  };

  const draft = async () => {
    say();
    const room = 100 - qs.length;
    if (room <= 0) return say("", "A test can have up to 100 questions. Remove one first.");
    cancel.current = { stop: false };
    setBusy("draft");
    try {
      let text = source;
      let total: number;
      if (aiMode === "topic") {
        if (topic.trim().length < 3) { setBusy(""); return say("", "Tell the AI what the questions are about, for example: Photosynthesis for Grade 8."); }
        say("Step 1 of 2: the AI is writing short notes on your topic. The questions will come from these notes, so you can check them.");
        const r = await api<{ text: string }>("/api/assist", { action: "write", role: "teacher", audience, instruction: `${topic.trim()}. Include enough different facts for about ${topicCount} questions.`, text: "", context: "" });
        text = r.text; setSource(r.text); setNoteId("");
        total = Math.min(room, resolveCount(topicCount, r.text.trim().length));
      } else {
        if (text.trim().length < 40) { setBusy(""); return say("", "Choose a note, or paste or upload some text first (at least 40 characters)."); }
        total = Math.min(room, resolveCount(count, text.trim().length));
      }
      setProgress({ done: 0, total });
      const r = await generateQuestions({ notes: text, total, focus: aiMode === "topic" ? "" : focus, mix, level: "Intermediate", forTeacher: true, passcode, cancel: cancel.current, onProgress: (done, t) => setProgress({ done, total: t }) });
      setQs((old) => [...old, ...r.questions.map(fromServer)].slice(0, 100));
      const removed = r.findings.filter((f) => f.action === "removed").length;
      say(`Added ${r.questions.length} questions. ${r.checked ? `The AI double-checked them${removed ? ` and removed ${removed} weak one${removed > 1 ? "s" : ""}` : ""}.` : "They were not double-checked, so read each one carefully."} ${r.note} Please read and edit them on the page.`);
    } catch (e: any) { say("", e.message); }
    setBusy("");
  };

  const uploadSource = async (f?: File) => {
    if (!f) return;
    setBusy("file"); say("Reading your file…");
    try { const t = await readFileText(f, (m) => say(m)); setSource(t.slice(0, NOTE_MAX)); setNoteId(""); say(t.length > NOTE_MAX ? `Long file: I will use the first ${NOTE_MAX.toLocaleString()} characters.` : "File read."); }
    catch (e: any) { say("", e.message); }
    setBusy(""); if (file.current) file.current.value = "";
  };

  const save = async () => {
    say();
    if (title.trim().length < 2) return say("", "Give it a title first.");
    if (!qs.length) return say("", "Add at least one question.");
    setBusy("save");
    const body = { title, kind, instructions, showAnswers, open: isOpen, questions: qs.map(toServer) };
    try {
      if (current) {
        await api("/api/work", { action: "update", code: current.code, editKey: current.key, ...body });
        const next = mine.map((w) => (w.code === current.code ? { ...w, title, kind } : w));
        saveWork(next); setMine(next); setShown({ code: current.code });
        say("Saved. Learners see your changes straight away.");
      } else {
        const r = await api<{ code: string; editKey: string }>("/api/work", { action: "create", passcode, ...body });
        const w = { code: r.code, key: r.editKey, title, kind };
        const next = [w, ...mine]; saveWork(next); setMine(next); setCurrent(w); setShown({ code: r.code });
        say("Saved and shared! Give learners the code below.");
      }
    } catch (e: any) { say("", e.message); }
    setBusy("");
  };

  const forget = async (w: SavedWork) => {
    if (!confirm(`Delete "${w.title}" for everyone? Learners will no longer be able to open it and all results are lost.`)) return;
    try { await api("/api/work", { action: "delete", code: w.code, editKey: w.key }); } catch (e: any) { if (!/could not find/i.test(e.message)) return say("", e.message); }
    const next = mine.filter((x) => x.code !== w.code); saveWork(next); setMine(next); say("Deleted.");
  };

  const toggleOpen = async () => {
    if (!current) return;
    setBusy("open");
    try {
      await api("/api/work", { action: "update", code: current.code, editKey: current.key, open: !isOpen });
      setIsOpen(!isOpen); if (results) setResults({ ...results, open: !isOpen });
    } catch (e: any) { say("", e.message); }
    setBusy("");
  };

  /* ---------- download / print ---------- */
  const asDoc = (withAnswers: boolean): ExportDoc => ({
    title: title.trim() || "Test", kindName: kindName(kind), instructions, withAnswers,
    questions: qs.map((q) => ({ kind: q.kind, text: q.text, topic: q.topic, why: q.why, options: q.options, answer: q.answer, steps: q.steps, expected: q.expected })),
  });
  const finished = (): boolean => {
    const bad = qs.findIndex((q) => !q.text.trim() || (q.kind === "choice" && q.options.some((o) => !o.trim())) || (q.kind === "order" && q.steps.some((o) => !o.trim())) || (q.kind === "explain" && !q.expected.trim()));
    if (bad >= 0) { say("", `Question ${bad + 1} is not finished yet. Complete it, then download.`); return false; }
    say(); return true;
  };
  const getPdf = async () => {
    if (!finished()) return;
    setBusy("pdf");
    try {
      const r = await downloadDocPdf(asDoc(copy === "teacher"));
      say(r.lossy ? "PDF downloaded. A few special characters cannot be shown in a PDF and appear as “?”. Use Download Word or Print to keep them." : "PDF downloaded.");
    } catch { say("", "I could not make the PDF. Try Download Word or Print instead."); }
    setBusy("");
  };
  const getWord = () => { if (finished()) { downloadDocWord(asDoc(copy === "teacher")); say("Word file downloaded."); } };
  const printIt = () => { if (finished()) window.print(); };

  /* ---------- results ---------- */
  if (view === "results" && results && current) return (
    <Page title={`Results: ${results.title}`} onBack={() => { setView("list"); say(); }} backLabel="My tests">
      <div className="tiles">
        <div><b>{results.count}</b><span>handed in</span></div>
        <div className={results.average >= 70 ? "good" : ""}><b>{results.average}%</b><span>class average</span></div>
      </div>
      <div className="actions">
        <button className="ghost" disabled={!!busy} onClick={() => openExisting(current, "results")}>Refresh</button>
        <button className="ghost" disabled={!!busy} onClick={toggleOpen}>{isOpen ? "Stop accepting answers" : "Accept answers again"}</button>
        <button className="ghost" onClick={() => window.print()}>Print or save as PDF</button>
      </div>
      <Msg error={msg.error} ok={msg.ok} />
      {results.count === 0 ? <p className="empty">Nobody has handed this in yet. Share the code <b>{current.code}</b> with your learners.</p> : (
        <>
          <h3>{results.weakTopics.length ? "Topics to teach again" : "Everything is looking good"}</h3>
          {results.weakTopics.length > 0 && <p>These topics are below 70% for the class: <b>{results.weakTopics.join(", ")}</b>. A short reteach could help.</p>}
          <ul className="meters">{results.byTopic.map((t) => <li key={t.topic}><span>{t.topic}</span><span className="mtrack"><span className={"mfill" + (t.pct < 70 ? " low" : "")} style={{ width: `${t.pct}%` }} /></span><b>{t.pct}%</b></li>)}</ul>
          <h3>Question by question</h3>
          <ul className="meters">{results.questions.map((q, i) => <li key={q.id}><span>{i + 1}. {q.text.slice(0, 60)}</span><span className="mtrack"><span className={"mfill" + (q.pct < 50 ? " low" : "")} style={{ width: `${q.pct}%` }} /></span><b>{q.pct}%</b></li>)}</ul>
          <p><small>A very low question may be unclear or have the wrong answer marked. Check it before blaming the class.</small></p>
          <h3>Learners</h3>
          <ul className="rows">{results.submissions.map((s) => (
            <li key={s.nickname + s.at}><details className="row"><summary><b>{s.nickname}</b> <span className="tag">{s.right} / {s.total}</span> <small>{new Date(s.at).toLocaleString()}</small></summary>
              {s.written.length ? s.written.map((w, i) => <p key={i}><small>{w.question}</small><br />{w.correct ? "✓" : "✗"} {w.answer}</p>) : <p><small>No written answers.</small></p>}
            </details></li>
          ))}</ul>
        </>
      )}
    </Page>
  );

  /* ---------- build / edit ---------- */
  const aiPanel = (
    <details className="nb-ai" open={qs.length === 0}>
      <summary>✨ Ask the AI to write questions</summary>
      <div className="nb-ai-body">
        <div className="nb-tabs" role="tablist" aria-label="Where should the questions come from?">
          <button role="tab" aria-selected={aiMode === "topic"} className={aiMode === "topic" ? "on" : ""} onClick={() => setAiMode("topic")}>From a topic</button>
          <button role="tab" aria-selected={aiMode === "notes"} className={aiMode === "notes" ? "on" : ""} onClick={() => setAiMode("notes")}>From my notes or a file</button>
        </div>
        {aiMode === "topic" ? (<>
          <label className="answer-field"><span>What is it about?</span><input value={topic} maxLength={200} placeholder="For example: Photosynthesis, Grade 8" onChange={(e) => setTopic(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !busy && draft()} /></label>
          <div className="grid2">
            <label className="answer-field"><span>How many questions?</span><select value={topicCount} onChange={(e) => setTopicCount(Number(e.target.value))}>{[5, 10, 15, 20, 30].map((n) => <option key={n} value={n}>{n} questions</option>)}</select></label>
            <label className="answer-field"><span>Learners</span><select value={audience} onChange={(e) => setAudience(e.target.value)}>{["Primary school learners", "High school learners", "College or university students", "Adult learners"].map((a) => <option key={a}>{a}</option>)}</select></label>
          </div>
          <p><small>The AI first writes short notes on your topic, then makes questions from those notes. You can read the notes and fix them under “From my notes”.</small></p>
        </>) : (<>
          <p><small>The AI uses <b>only</b> the text below, so the questions match what you taught.</small></p>
          <NotePicker role="teacher" value={noteId} onChange={(id, n) => { setNoteId(id); if (n) setSource(n.body); }} />
          <p><button className="ghost" disabled={!!busy} onClick={() => file.current?.click()}>…or upload a PDF or Word file</button>
            <input ref={file} type="file" hidden accept=".pdf,.docx,.txt,.md,.csv" onChange={(e) => uploadSource(e.target.files?.[0])} aria-label="Upload a PDF or Word file" /></p>
        </>)}
        {(aiMode === "notes" || source.trim()) && (
          <label className="answer-field"><span>Text the questions come from <small>(paste or edit here)</small></span>
            <textarea rows={5} maxLength={NOTE_MAX} value={source} onChange={(e) => { setSource(e.target.value); setNoteId(""); }} /></label>)}
        {aiMode === "notes" && <CountPicker text={source} value={count} onChange={setCount} />}
        <div className="grid2">
          <label className="answer-field"><span>Kind of questions</span><select value={mix} onChange={(e) => setMix(e.target.value as typeof mix)}><option value="mixed">A mix</option><option value="choice">Multiple choice only</option><option value="written">Written answers only</option></select></label>
          {aiMode === "notes" && <label className="answer-field"><span>Focus <small>(optional)</small></span><input value={focus} maxLength={200} onChange={(e) => setFocus(e.target.value)} /></label>}
        </div>
        <PasscodeBox value={passcode} onChange={setPasscode} />
        <div className="actions"><button className="btn" disabled={!!busy} onClick={draft}>{busy === "draft" ? "Writing…" : qs.length ? "Add more questions with AI" : "Write questions with AI"}</button></div>
        {busy === "draft" && <Progress done={progress.done} total={progress.total} label="Writing and checking questions…" onStop={() => { cancel.current.stop = true; }} />}
        <Msg error={msg.error} ok={msg.ok} />
      </div>
    </details>
  );

  if (view === "build") return (
    <Page title={current ? "Edit your test or classwork" : "Create a test or classwork"} printTitle={false} onBack={() => { setView("list"); say(); setShown(null); }} backLabel="My tests"
      help="Work on it like a notebook page: click any text to change it. The AI drafts, you decide.">
      <div className="no-print">
      <BlockEditor title={title} setTitle={setTitle} kinds={KINDS} kind={kind} setKind={setKind} instructions={instructions} setInstructions={setInstructions}
        showAnswers={showAnswers} setShowAnswers={setShowAnswers} qs={qs} setQs={setQs} aiSlot={aiPanel} />

      <section className="teacher-card">
        <h3>Save and share</h3>
        <PasscodeBox value={passcode} onChange={setPasscode} />
        <button className="btn" disabled={!!busy || !qs.length} onClick={save}>{busy === "save" ? "Saving…" : current ? "Save changes" : "Save and get link"}</button>
        {busy !== "draft" && <Msg error={msg.error} ok={msg.ok} />}
        {shown && (<>
          <p>Learners open this {kindName(kind).toLowerCase()} with the link, the QR code or the code:</p>
          <ShareBox code={shown.code} title={title.trim() || kindName(kind)} what={kindName(kind)} />
          <div className="actions"><button className="ghost" onClick={() => current && openExisting(current, "results")}>See results</button></div>
          <p><small>The correct answers stay on the server until a learner hands in.</small></p>
        </>)}
        {!shown && <p><small>Changing questions after learners have answered clears the old results, so the results always match the questions.</small></p>}
      </section>

      <section className="teacher-card" id="export-panel">
        <h3>Download or print</h3>
        <p>Get a copy to hand out on paper or upload to your school system. You do not need to save or share first.</p>
        <fieldset className="copypick"><legend>Which copy?</legend>
          <label className="check"><input type="radio" name="copy" checked={copy === "student"} onChange={() => setCopy("student")} /> <span><b>Student copy</b> — questions only, with a name line and space to write</span></label>
          <label className="check"><input type="radio" name="copy" checked={copy === "teacher"} onChange={() => setCopy("teacher")} /> <span><b>Teacher copy</b> — with the correct answers and explanations (the memo)</span></label>
        </fieldset>
        <div className="actions">
          <button className="btn" disabled={!qs.length || !!busy} onClick={getPdf}>{busy === "pdf" ? "Making PDF…" : "Download PDF"}</button>
          <button className="ghost" disabled={!qs.length} onClick={getWord}>Download Word</button>
          <button className="ghost" disabled={!qs.length} onClick={printIt}>Print</button>
        </div>
        {!qs.length && <p><small>Add some questions first.</small></p>}
      </section>
      </div>
      {/* Only this is printed when you press Print. */}
      <div className="print-only" dangerouslySetInnerHTML={{ __html: docHtml(asDoc(copy === "teacher")) }} />
    </Page>
  );

  /* ---------- list ---------- */
  return (
    <Page title="Tests and classwork" onBack={onBack} help="Create a test, exam, classwork or homework with AI help. Edit every question. Share it with a code. See who needs help.">
      <div className="actions"><button className="btn" onClick={startNew}>Create a new one</button></div>
      <Msg error={msg.error} ok={msg.ok} />
      {mine.length === 0 ? <p className="empty">You have not made any yet. Press “Create a new one”.</p> : (
        <ul className="rows">{mine.map((w) => (
          <li key={w.code} className="workrow">
            <div><b>{w.title}</b> <span className="tag">{kindName(w.kind)}</span><br /><small>Code: <b>{w.code}</b></small></div>
            <div className="actions">
              <button className="ghost" disabled={!!busy} onClick={() => openExisting(w, "build")}>Edit</button>
              <button className="ghost" disabled={!!busy} onClick={() => { setWantExport(true); void openExisting(w, "build"); }}>Download / Print</button>
              <button className="ghost" disabled={!!busy} onClick={() => openExisting(w, "results")}>Results</button>
              <button className="ghost" aria-expanded={sharing === w.code} onClick={() => setSharing(sharing === w.code ? null : w.code)}>Link / QR</button>
              <button className="ghost danger" onClick={() => forget(w)}>Delete</button>
            </div>
            {sharing === w.code && <div className="workshare"><ShareBox code={w.code} title={w.title} what={kindName(w.kind)} /></div>}
          </li>))}</ul>)}
      <p><small>This list is kept in this browser, together with your private teacher keys. If you clear your browser data or use another computer, you lose the ability to edit these. Use the same browser each time.</small></p>
    </Page>
  );
}
