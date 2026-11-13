"use client";
import { useRef, useState } from "react";
import { score, type Finding, type Question, type TestAnswer } from "../lib/agent";
import { api, generateQuestions, loadNotes, type Cancel, type LocalNote } from "../lib/client";
import { Quiz, answerText } from "./App";
import { CountPicker, HowTo, Msg, NotePicker, Page, Progress, resolveCount, type CountChoice } from "./ui";

type Phase = "setup" | "making" | "test" | "marking" | "result";

export default function PracticeTest({ note, onBack }: { note?: LocalNote | null; onBack: () => void }) {
  const [noteId, setNoteId] = useState(note?.id || "");
  const [text, setText] = useState(note?.body || "");
  const [focus, setFocus] = useState("");
  const [count, setCount] = useState<CountChoice>("auto");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [info, setInfo] = useState("");
  const cancel = useRef<Cancel>({ stop: false });
  const [hard, setHard] = useState<"Beginner" | "Intermediate" | "Advanced">("Beginner");
  const [phase, setPhase] = useState<Phase>("setup");
  const [qs, setQs] = useState<Question[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [checked, setChecked] = useState(false);
  const [vals, setVals] = useState<TestAnswer[]>([]);
  const [grades, setGrades] = useState<(boolean | undefined)[]>([]);
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  const make = async (focusOverride?: string, forceTotal?: number) => {
    setError(""); setInfo("");
    if (text.trim().length < 40) return setError("Choose a note with a little more text (at least 40 characters).");
    const total = forceTotal ?? resolveCount(count, text.trim().length);
    cancel.current = { stop: false };
    setProgress({ done: 0, total }); setPhase("making");
    try {
      const r = await generateQuestions({ notes: text, total, focus: focusOverride ?? focus, level: hard, mix: "mixed", cancel: cancel.current, onProgress: (done, t) => setProgress({ done, total: t }) });
      setQs(r.questions); setFindings(r.findings); setChecked(r.checked); setInfo(r.note);
      setVals(r.questions.map(() => null)); setGrades([]); setFeedback({});
      setPhase("test");
    } catch (e: any) { setError(e.message); setPhase("setup"); }
  };

  const mark = async () => {
    setError("");
    const unanswered = vals.findIndex((v, i) => v === null || (qs[i].kind === "explain" && !String(v).trim()));
    if (unanswered >= 0) return setError(`Please answer question ${unanswered + 1}. For ordering questions, press “Confirm this order”.`);
    setPhase("marking");
    try {
      const written = qs.map((q, i) => ({ q, i })).filter(({ q }) => q.kind === "explain");
      const g: (boolean | undefined)[] = qs.map(() => undefined);
      const fb: Record<string, string> = {};
      if (written.length) {
        const r = await api<{ grades: Record<string, { correct: boolean; feedback: string }> }>("/api/study", {
          action: "grade",
          responses: written.map(({ q, i }) => ({ id: q.id, text: q.text, expectedAnswer: (q as any).expectedAnswer, sig: q.sig, response: String(vals[i]) })),
        });
        written.forEach(({ q, i }) => { g[i] = r.grades[q.id]?.correct ?? false; fb[q.id] = r.grades[q.id]?.feedback || ""; });
      }
      setGrades(g); setFeedback(fb); setPhase("result");
    } catch (e: any) { setError(e.message); setPhase("test"); }
  };

  const result = phase === "result" ? score(qs, vals, grades) : null;
  const again = (topics: string[]) => { setFocus(topics.join(", ")); void make(topics.join(", "), Math.min(10, Math.max(3, topics.length * 3))); };

  return (
    <Page title="Test myself" onBack={onBack} backLabel="Back"
      help="The AI writes questions from your own note, then double-checks them. Every question shows the part of your note it came from.">
      {phase === "setup" && (
        <>
          <HowTo steps={["Choose one of your notes.", "Press “Make my test”.", "Answer the questions, then press “Check my answers”."]} />
          <NotePicker role="learner" value={noteId} onChange={(id, n) => { setNoteId(id); setText(n?.body || ""); }} />
          <CountPicker text={text} value={count} onChange={setCount} />
          <details className="src"><summary>More options (you can skip these)</summary>
            <label className="answer-field"><span>Test me only on… <small>(optional, e.g. “chlorophyll”)</small></span>
              <input value={focus} maxLength={200} onChange={(e) => setFocus(e.target.value)} />
            </label>
            <label className="answer-field"><span>How hard?</span>
              <select value={hard} onChange={(e) => setHard(e.target.value as typeof hard)}><option value="Beginner">Easy</option><option value="Intermediate">Medium</option><option value="Advanced">Hard</option></select>
            </label>
          </details>
          <button className="btn" disabled={!text} onClick={() => make()}>Make my test</button>
          {!loadNotes("learner").length && <p><small>You need a note first. Go back and choose “My notes”.</small></p>}
          <Msg error={error} />
        </>
      )}

      {phase === "making" && <Progress done={progress.done} total={progress.total} label="Writing and checking questions…" onStop={() => { cancel.current.stop = true; }} />}

      {(phase === "test" || phase === "marking") && (
        <>
          <p className="note-ok">{checked ? `The AI double-checked these questions: ${findings.filter((f) => f.action === "approved").length} approved, ${findings.filter((f) => f.action === "fixed").length} fixed, ${findings.filter((f) => f.action === "removed").length} removed.` : "These questions were not double-checked this time. Treat them with care."}</p>
          {info && <p className="warn">{info}</p>}
          <Quiz qs={qs} vals={vals} onPick={(i, o) => setVals((v) => v.map((x, j) => (j === i ? o : x)))} />
          <Msg error={error} />
          <p><small>Answered {vals.filter((v) => v !== null && String(v).trim() !== "").length} of {qs.length}</small></p>
          <button className="btn" disabled={phase === "marking"} onClick={mark}>{phase === "marking" ? "Checking…" : "Check my answers"}</button>
        </>
      )}

      {result && (
        <>
          <h3>You got {result.right} of {qs.length}</h3>
          <ul className="meters">{Object.entries(result.pct).map(([t, p]) => (
            <li key={t}><span>{t}</span><span className="mtrack"><span className="mfill" style={{ width: `${p}%` }} /></span><b>{p}%</b></li>
          ))}</ul>
          {qs.map((q, i) => {
            const ok = grades[i] ?? (q.kind === "choice" ? vals[i] === q.answer : q.kind === "order" && Array.isArray(vals[i]) && (vals[i] as string[]).join("|") === q.answer.join("|"));
            return (
              <section key={q.id} className={"review " + (ok ? "right" : "wrong")}>
                <p><b>{ok ? "✓ Correct" : "✗ Not quite"}</b> — {q.text}</p>
                {!ok && <p>Correct answer: <b>{answerText(q)}</b></p>}
                {feedback[q.id] && <p>{feedback[q.id]}</p>}
                <p><small>{q.why}</small></p>
                {q.ref && <blockquote className="ref"><small>From your note:</small> {q.ref}{q.ref.length >= 300 ? "…" : ""}</blockquote>}
              </section>
            );
          })}
          <div className="actions">
            {result.weak.length > 0 && <button className="btn" onClick={() => again(result.weak)}>Practise what I missed</button>}
            <button className="ghost" onClick={() => { setPhase("setup"); setFocus(""); }}>Make a new test</button>
            <button className="ghost" onClick={onBack}>Done</button>
          </div>
          <Msg error={error} />
        </>
      )}
    </Page>
  );
}
