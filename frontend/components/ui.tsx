"use client";
import { useEffect, useState, type ReactNode } from "react";

/** A short heading with plain-language help text under it. Used at the top of every screen. */
export function Page({ title, help, onBack, backLabel = "Back", printTitle = true, children }: { title: string; help?: ReactNode; onBack?: () => void; backLabel?: string; printTitle?: boolean; children: ReactNode }) {
  return (
    <section className="page">
      {onBack && <button className="crumb" onClick={onBack}>← {backLabel}</button>}
      <h2 className={printTitle ? undefined : "no-print"}>{title}</h2>
      {help && <p className={"help" + (printTitle ? "" : " no-print")}>{help}</p>}
      {children}
    </section>
  );
}

/** A numbered list of "what to do next", so nobody has to guess. */
export function HowTo({ steps }: { steps: string[] }) {
  return (
    <ol className="howto" aria-label="How this works">
      {steps.map((s, i) => <li key={i}><span>{i + 1}</span>{s}</li>)}
    </ol>
  );
}

/** Shows an error or a success line, and tells screen readers. */
export function Msg({ error, ok }: { error?: string; ok?: string }) {
  if (error) return <p className="warn err" role="alert">{error}</p>;
  if (ok) return <p className="note-ok" role="status">{ok}</p>;
  return null;
}

/** A big, friendly choice card. */
export function Card({ n, title, text, onClick, badge }: { n?: number; title: string; text: string; onClick: () => void; badge?: string }) {
  return (
    <button className="bigcard" onClick={onClick}>
      {n !== undefined && <span className="bignum" aria-hidden="true">{n}</span>}
      <span className="bigtext"><b>{title}</b><small>{text}</small></span>
      {badge && <span className="bigbadge">{badge}</span>}
    </button>
  );
}

/** Copies text and says so. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => { if (done) { const t = setTimeout(() => setDone(false), 1800); return () => clearTimeout(t); } }, [done]);
  return (
    <button className="ghost" onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); } catch { /* ignore */ } }}>
      {done ? "Copied ✓" : label}
    </button>
  );
}

/** Asks "are you sure?" in plain words before anything is deleted. */
export function useConfirm() {
  return (message: string) => (typeof window === "undefined" ? false : window.confirm(message));
}

/** Teachers only: asks for the teacher passcode when the person running the app has set one. */
let needsCache: boolean | null = null;
export function usePasscodeNeeded(): boolean {
  const [needed, setNeeded] = useState<boolean>(needsCache ?? false);
  useEffect(() => {
    if (needsCache !== null) return;
    fetch("/api/notes").then((r) => r.json()).then((d) => { needsCache = !!d.passcodeRequired; setNeeded(needsCache); }).catch(() => undefined);
  }, []);
  return needed;
}
export function PasscodeBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const needed = usePasscodeNeeded();
  if (!needed) return null;
  return (
    <label className="answer-field passbox">
      <span>Teacher passcode <small>(ask the person who set up this app)</small></span>
      <input type="password" autoComplete="off" value={value} maxLength={200} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** "Which note?" — a dropdown of the notes saved on this device. */
import { loadNotes, type LocalNote, type Role } from "../lib/client";
export function NotePicker({ role, value, onChange }: { role: Role; value: string; onChange: (id: string, note: LocalNote | null) => void }) {
  const [notes, setNotes] = useState<LocalNote[]>([]);
  useEffect(() => { setNotes(loadNotes(role)); }, [role]);
  return (
    <label className="answer-field"><span>Which note?</span>
      <select value={value} onChange={(e) => onChange(e.target.value, notes.find((n) => n.id === e.target.value) || null)}>
        <option value="">{notes.length ? "Choose a note…" : "You have no notes yet"}</option>
        {notes.map((n) => <option key={n.id} value={n.id}>{n.title || "Untitled note"}</option>)}
      </select>
    </label>
  );
}


/** "How many questions?" Automatic suggestion based on the length of the text, or the person's own number. */
import { countOptions, maxCount, suggestCount, wordsOf } from "../lib/sizing";
export type CountChoice = "auto" | number;
export const resolveCount = (c: CountChoice, chars: number) => (c === "auto" ? suggestCount(chars) : Math.min(c, maxCount(chars)));
export function CountPicker({ text, value, onChange }: { text: string; value: CountChoice; onChange: (v: CountChoice) => void }) {
  const chars = text.trim().length;
  const auto = suggestCount(chars);
  const total = resolveCount(value, chars);
  return (
    <label className="answer-field"><span>How many questions?</span>
      <select value={String(value)} onChange={(e) => onChange(e.target.value === "auto" ? "auto" : Number(e.target.value))}>
        <option value="auto">Automatic: {auto} {auto === 1 ? "question" : "questions"} (fits the length of your text)</option>
        {countOptions(chars).map((n) => <option key={n} value={n}>{n} questions</option>)}
      </select>
      <small>{chars ? `Your text is about ${wordsOf(text).toLocaleString()} words, so up to ${maxCount(chars)} questions fit. ` : "Choose a note first. "}{total > 10 ? `Writing ${total} questions takes about ${Math.ceil(total / 10) * 20} seconds.` : ""}</small>
    </label>
  );
}

/** A progress line with a Stop button, for work that takes a while. */
export function Progress({ done, total, label, onStop }: { done: number; total: number; label: string; onStop?: () => void }) {
  const pct = total ? Math.min(100, Math.round((100 * done) / total)) : 0;
  return (
    <div className="working-box" role="status" aria-live="polite">
      <p><span className="spin" aria-hidden="true" /> {label} <b>{done}</b> of <b>{total}</b> done</p>
      <span className="mtrack"><span className="mfill" style={{ width: `${pct}%` }} /></span>
      {onStop && <button className="ghost" onClick={onStop}>Stop</button>}
    </div>
  );
}


/** Shows "The AI is resting, continuing in N seconds" while the page waits to retry on its own. */
export function WaitBanner() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const on = (e: Event) => setSeconds(Number((e as CustomEvent).detail) || 0);
    window.addEventListener("prooflearn-wait", on);
    return () => window.removeEventListener("prooflearn-wait", on);
  }, []);
  if (!seconds) return null;
  return <p className="note-ok waitbar" role="status" aria-live="polite"><span className="spin" aria-hidden="true" /> The AI needs a short rest because lots of text was sent to it. Carrying on by itself in <b>{seconds}</b> second{seconds === 1 ? "" : "s"}. You do not need to do anything.</p>;
}
