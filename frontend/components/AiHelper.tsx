"use client";
import { useEffect, useRef, useState } from "react";
import { api, NOTE_MAX, type Role } from "../lib/client";
import { Msg } from "./ui";

type Sel = { start: number; end: number } | null;
const AUDIENCES = ["Me, a beginner", "Primary school learners", "High school learners", "College or university students", "Adult learners"];

const BASE: [string, string, string][] = [
  ["improve", "Fix my writing", "Corrects spelling and grammar. Keeps your meaning."],
  ["structure", "Organise with headings", "Turns messy text into tidy notes with headings and bullets."],
  ["shorten", "Make it shorter", "Keeps the key facts in about half the words."],
  ["simplify", "Explain more simply", "Easier words and shorter sentences."],
  ["continue", "Continue writing", "Adds the next section."],
  ["example", "Add an example", "A worked example, step by step."],
  ["terms", "Add key words", "A list of key terms and what they mean."],
];
const TEACHER: [string, string, string][] = [
  ["objectives", "Add learning objectives", "“By the end of this lesson, learners can…”"],
  ["summary", "Add a summary", "A short summary and key points for learners."],
];

export default function AiHelper({ role, body, sel, startOpen, focusTopic, canUndo, onApply, onUndo }: {
  role: Role; body: string; sel: Sel; startOpen: boolean; focusTopic: boolean; canUndo: boolean;
  onApply: (mode: "replace" | "append", text: string, selection: Sel) => string | void; onUndo: () => void;
}) {
  const [audience, setAudience] = useState(role === "teacher" ? "High school learners" : "Me, a beginner");
  const [topic, setTopic] = useState("");
  const [ask, setAsk] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ text: string; mode: "replace" | "append"; selection: Sel } | null>(null);
  const topicRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (focusTopic) topicRef.current?.focus(); }, [focusTopic]);

  const picked = sel && sel.end - sel.start >= 10 ? sel : null;
  const target = picked ? body.slice(picked.start, picked.end) : body.length <= 8000 ? body : "";
  const empty = body.trim().length < 20;

  const run = async (action: string, instruction = "") => {
    setError(""); setResult(null);
    const replaces = ["improve", "structure", "shorten", "simplify"].includes(action);
    if (replaces && !picked && body.length > 8000) return setError("This note is long. Select the part you want to change (up to 8,000 letters), then press the button again.");
    setBusy(action);
    try {
      const r = await api<{ text: string; mode: "replace" | "append" }>("/api/assist", { action, role, audience, instruction, text: replaces ? target : picked ? target : "", context: body });
      setResult({ text: r.text, mode: r.mode, selection: picked });
    } catch (e: any) { setError(e.message); }
    setBusy("");
  };

  const apply = (mode: "replace" | "append") => {
    if (!result) return;
    const problem = onApply(mode, result.text, result.selection);
    if (problem) return setError(problem);
    setResult(null); setTopic(""); setAsk("");
  };

  const buttons = role === "teacher" ? [...BASE, ...TEACHER] : BASE;
  return (
    <details className="aihelper no-print" open={startOpen}>
      <summary><span aria-hidden="true">✨</span> AI helper — {empty ? "not sure where to start? Ask me to write it" : "ask me to improve your notes"}</summary>
      <p>{role === "teacher" ? "Tell the AI what your lesson is about and it writes a first draft for your learners. You can also paste your own text and ask it to tidy, simplify or add to it." : "Type or paste your notes above, or let the AI write a first draft. Then ask it to improve them."} <b>You decide:</b> nothing changes until you press “Use this”.</p>
      <div className="grid2">
        <label className="answer-field"><span>Write for</span>
          <select value={audience} onChange={(e) => setAudience(e.target.value)}>{AUDIENCES.map((a) => <option key={a}>{a}</option>)}</select></label>
        <p className="working-on"><small>The AI will work on: <b>{picked ? `your selected text (${(picked.end - picked.start).toLocaleString()} letters)` : empty ? "nothing yet" : "your whole note"}</b>.<br />Tip: select part of your note with the mouse to change only that part.</small></p>
      </div>

      <label className="answer-field"><span>Write new notes about…</span>
        <span className="inline"><input ref={topicRef} value={topic} maxLength={500} placeholder={role === "teacher" ? "For example: fractions for Grade 6, with two examples" : "For example: how photosynthesis works"}
          onChange={(e) => setTopic(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !busy && topic.trim().length > 2 && run("write", topic)} />
          <button className="btn" disabled={!!busy || topic.trim().length < 3} onClick={() => run("write", topic)}>{busy === "write" ? "Writing…" : "Write it"}</button></span></label>

      <p className="aibtns-title"><b>Or help with what I have written:</b></p>
      <div className="aibtns">
        {buttons.map(([id, label, hint]) => (
          <button key={id} className="ghost" title={hint} disabled={!!busy || empty} onClick={() => run(id)}>{busy === id ? "Working…" : label}</button>
        ))}
      </div>
      <label className="answer-field"><span>Or tell the AI what you want</span>
        <span className="inline"><input value={ask} maxLength={500} placeholder="For example: add a short quiz at the end" onChange={(e) => setAsk(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && ask.trim().length > 2 && run("custom", ask)} />
          <button className="ghost" disabled={!!busy || ask.trim().length < 3} onClick={() => run("custom", ask)}>{busy === "custom" ? "Working…" : "Go"}</button></span></label>

      {busy && <p className="working" role="status"><span className="spin" aria-hidden="true" /> The AI is writing… (about 10 seconds)</p>}
      <Msg error={error} />
      {result && (
        <section className="airesult" aria-label="AI suggestion">
          <p><b>The AI suggests this</b> <small>— AI can make mistakes. Please read it and check the facts.</small></p>
          <pre>{result.text}</pre>
          <div className="actions">
            {result.mode === "replace"
              ? <><button className="btn" onClick={() => apply("replace")}>Use this instead of {result.selection ? "my selected text" : "my note"}</button><button className="ghost" onClick={() => apply("append")}>Add to the end</button></>
              : <><button className="btn" onClick={() => apply("append")}>Add to the end of my note</button>{!result.selection && <button className="ghost" onClick={() => apply("replace")}>Replace my whole note</button>}</>}
            <button className="ghost" onClick={() => setResult(null)}>No thanks</button>
          </div>
        </section>
      )}
      {canUndo && <p><button className="link" onClick={onUndo}>↩ Undo the last AI change</button></p>}
    </details>
  );
}
