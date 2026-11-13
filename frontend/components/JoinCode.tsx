"use client";
import { useEffect, useState } from "react";
import { addLocalNote, api, asQuiz, downloadNotePdf, downloadWord, type LocalNote, type PublicQ } from "../lib/client";
import type { TestAnswer } from "../lib/agent";
import { Quiz } from "./App";
import { HowTo, Msg, Page } from "./ui";

type SharedNote = { kind: "note"; code: string; title: string; body: string };
type SharedWork = { kind: "work"; code: string; title: string; type: string; instructions: string; questions: PublicQ[] };
type Outcome = { right: number; total: number; pct: Record<string, number>; results: { id: string; text: string; correct: boolean; feedback: string; why?: string; correctAnswer?: string }[] };

export default function JoinCode({ initialCode, onBack, onSaved }: { initialCode?: string; onBack: () => void; onSaved: (n: LocalNote, thenTest: boolean) => void }) {
  const [code, setCode] = useState(initialCode || "");
  const [item, setItem] = useState<SharedNote | SharedWork | null>(null);
  const [vals, setVals] = useState<TestAnswer[]>([]);
  const [nick, setNick] = useState("");
  const [out, setOut] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fileMsg, setFileMsg] = useState({ ok: "", error: "" });
  const getPdf = async (title: string, body: string) => {
    try { const r = await downloadNotePdf(title, body); setFileMsg({ ok: r.lossy ? "PDF downloaded. A few special characters cannot be shown in a PDF and appear as “?”. Use Download as Word to keep them." : "PDF downloaded.", error: "" }); }
    catch { setFileMsg({ ok: "", error: "I could not make the PDF. Try Download as Word instead." }); }
  };

  const open = async (raw = code) => {
    setError(""); setItem(null); setOut(null);
    const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (c.length !== 8) return setError("A code has 8 letters and numbers, like NABC-D234. Check what your teacher gave you.");
    setBusy(true);
    try {
      if (c[0] === "N") { const r = await api<{ title: string; body: string }>("/api/notes", { action: "get", code: c }); setItem({ kind: "note", code: c, ...r }); }
      else if (c[0] === "T") {
        const r = await api<any>("/api/work", { action: "get", code: c });
        setItem({ kind: "work", code: c, title: r.title, type: r.kind, instructions: r.instructions, questions: r.questions }); setVals(r.questions.map(() => null));
      } else setError("That code does not look right. Codes start with N (notes) or T (test).");
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  };
  useEffect(() => { if (initialCode) void open(initialCode); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const handIn = async () => {
    if (item?.kind !== "work") return;
    setError("");
    const missing = vals.filter((v) => v === null || (typeof v === "string" && !v.trim())).length;
    if (missing && !window.confirm(`You have ${missing} unanswered question${missing > 1 ? "s" : ""}. Hand in anyway?`)) return;
    setBusy(true);
    try {
      setOut(await api<Outcome>("/api/work", { action: "submit", code: item.code, nickname: nick, answers: item.questions.map((q, i) => ({ id: q.id, value: vals[i] })).filter((a) => a.value !== null) }));
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  };

  return (
    <Page title={item ? item.title : "Open something from my teacher"} onBack={onBack} backLabel="Back"
      help={item ? undefined : "Your teacher gave you a code. Type it here to read their notes or do their test. You do not need an account."}>
      {!item && (
        <>
          <HowTo steps={["Type the code your teacher gave you.", "Press “Open”.", "Read the notes, or answer the questions."]} />
          <label className="answer-field"><span>Code</span>
            <input className="codebox" value={code} maxLength={12} autoCapitalize="characters" autoComplete="off" placeholder="NABC-D234"
              onChange={(e) => setCode(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === "Enter" && !busy && open()} /></label>
          <button className="btn" disabled={busy || !code.trim()} onClick={() => open()}>{busy ? "Opening…" : "Open"}</button>
          <Msg error={error} />
        </>
      )}

      {item?.kind === "note" && (
        <>
          <p><small>Notes from your teacher. This is a copy you can keep.</small></p>
          <article className="readnote">{item.body}</article>
          <div className="actions">
            <button className="btn" onClick={() => onSaved(addLocalNote("learner", item.title, item.body), true)}>Save to my notes and test myself</button>
            <button className="ghost" onClick={() => onSaved(addLocalNote("learner", item.title, item.body), false)}>Just save to my notes</button>
            <button className="ghost" onClick={() => { downloadWord(item.title, item.body); setFileMsg({ ok: "Word file downloaded.", error: "" }); }}>Download as Word</button>
            <button className="ghost" onClick={() => void getPdf(item.title, item.body)}>Download as PDF</button>
          </div>
          <Msg ok={fileMsg.ok} error={fileMsg.error} />
        </>
      )}

      {item?.kind === "work" && !out && (
        <>
          {item.instructions && <p className="note-ok"><b>From your teacher:</b> {item.instructions}</p>}
          <label className="answer-field"><span>Your nickname <small>(your teacher will see this. Please do not use your full name or any private details.)</small></span>
            <input value={nick} maxLength={40} onChange={(e) => setNick(e.target.value)} placeholder="For example: Blue Fox" /></label>
          <Quiz qs={item.questions.map(asQuiz)} vals={vals} onPick={(i, o) => setVals((v) => v.map((x, j) => (j === i ? o : x)))} />
          <Msg error={error} />
          <button className="btn" disabled={busy} onClick={handIn}>{busy ? "Marking… (written answers can take a few seconds)" : "Hand in"}</button>
        </>
      )}

      {item?.kind === "work" && out && (
        <>
          <h3>You got {out.right} of {out.total}</h3>
          <ul className="meters">{Object.entries(out.pct).map(([t, p]) => <li key={t}><span>{t}</span><span className="mtrack"><span className="mfill" style={{ width: `${p}%` }} /></span><b>{p}%</b></li>)}</ul>
          {out.results.map((r, i) => (
            <section key={r.id} className={"review " + (r.correct ? "right" : "wrong")}>
              <p><b>{r.correct ? "✓ Correct" : "✗ Not quite"}</b> — {i + 1}. {r.text}</p>
              {!r.correct && r.correctAnswer && <p>Correct answer: <b>{r.correctAnswer}</b></p>}
              {r.feedback && <p>{r.feedback}</p>}
              {r.why && <p><small>{r.why}</small></p>}
            </section>
          ))}
          <p><small>Your teacher can see your nickname, your score and your written answers.</small></p>
          <button className="ghost" onClick={onBack}>Done</button>
        </>
      )}
    </Page>
  );
}
