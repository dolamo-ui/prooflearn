"use client";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Question } from "../lib/agent";

/* The teacher's test / classwork / homework as a page of blocks, like Notion or a notebook:
   a big title, a few properties, instructions, then one block per question.
   Hover a block for the drag handle (⠿), the + and the ⋮ menu. Type "/" at the bottom to add a block.
   It edits the same data the server already accepts, so nothing on the server changes. */

export type QKind = "choice" | "explain" | "order";
export type EQ = { key: string; kind: QKind; topic: string; text: string; why: string; options: string[]; answer: number; steps: string[]; expected: string };
let keyN = 0;
export const blank = (kind: QKind = "choice"): EQ => ({ key: `k${++keyN}`, kind, topic: "General", text: "", why: "", options: ["", "", "", ""], answer: 0, steps: ["", "", ""], expected: "" });
export const fromServer = (q: Question): EQ => ({
  key: `k${++keyN}`, kind: q.kind, topic: q.topic, text: q.text, why: q.why,
  options: q.kind === "choice" ? [...q.options] : ["", "", "", ""], answer: q.kind === "choice" ? q.answer : 0,
  steps: q.kind === "order" ? [...q.answer] : ["", "", ""], expected: q.kind === "explain" ? q.expectedAnswer : "",
});
export const toServer = (q: EQ) => q.kind === "choice" ? { kind: "choice", topic: q.topic, text: q.text, why: q.why, options: q.options.map((o) => o.trim()), answer: q.answer }
  : q.kind === "order" ? { kind: "order", topic: q.topic, text: q.text, why: q.why, options: q.steps.map((o) => o.trim()), answer: q.steps.map((o) => o.trim()) }
  : { kind: "explain", topic: q.topic, text: q.text, why: q.why, expectedAnswer: q.expected };

const TYPES: { k: QKind; label: string; hint: string; icon: string }[] = [
  { k: "choice", label: "Multiple choice", hint: "Pick one answer", icon: "◉" },
  { k: "explain", label: "Written answer", hint: "The AI marks it against your guide", icon: "✎" },
  { k: "order", label: "Put in order", hint: "Learners arrange the steps", icon: "↕" },
];

/** A box that grows as you type, with no border until you focus it. */
function Auto({ value, onChange, className = "", placeholder, max, onKeyDown, dataQ }: { value: string; onChange: (v: string) => void; className?: string; placeholder?: string; max?: number; onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void; dataQ?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { const t = ref.current; if (t) { t.style.height = "0px"; t.style.height = t.scrollHeight + "px"; } }, [value]);
  return <textarea ref={ref} rows={1} className={"nb-auto " + className} value={value} maxLength={max} placeholder={placeholder} data-q={dataQ} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) e.preventDefault(); onKeyDown?.(e); }} onChange={(e) => onChange(e.target.value.replace(/\n/g, " "))} />;
}
const focusLater = (sel: string) => setTimeout(() => (document.querySelector(sel) as HTMLElement | null)?.focus(), 30);

function TypeChips({ onPick }: { onPick: (k: QKind) => void }) {
  return <div className="nb-chips" role="group" aria-label="Add a question">{TYPES.map((t) => <button key={t.k} className="nb-chip" onClick={() => onPick(t.k)}><span aria-hidden="true">{t.icon}</span> {t.label}</button>)}</div>;
}

export default function BlockEditor({ title, setTitle, kinds, kind, setKind, instructions, setInstructions, showAnswers, setShowAnswers, qs, setQs, aiSlot }: {
  title: string; setTitle: (v: string) => void; kinds: [string, string][]; kind: string; setKind: (v: string) => void;
  instructions: string; setInstructions: (v: string) => void; showAnswers: boolean; setShowAnswers: (v: boolean) => void;
  qs: EQ[]; setQs: (f: (old: EQ[]) => EQ[]) => void; aiSlot?: ReactNode;
}) {
  const [menu, setMenu] = useState<{ type: "add" | "block"; at: number } | null>(null);
  const [slash, setSlash] = useState("");
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);

  const patch = (i: number, p: Partial<EQ>) => setQs((all) => all.map((q, j) => (j === i ? { ...q, ...p } : q)));
  const insert = (at: number, k: QKind) => {
    const q = blank(k);
    setQs((all) => (all.length >= 100 ? all : [...all.slice(0, at), q, ...all.slice(at)]));
    setMenu(null); setSlash(""); focusLater(`[data-q="${q.key}"]`);
  };
  const move = (i: number, to: number) => setQs((all) => { if (to < 0 || to >= all.length || to === i) return all; const n = [...all]; const [x] = n.splice(i, 1); n.splice(to, 0, x); return n; });
  const remove = (i: number) => { setQs((all) => all.filter((_, j) => j !== i)); setMenu(null); };
  const duplicate = (i: number) => { setQs((all) => (all.length >= 100 ? all : [...all.slice(0, i + 1), { ...all[i], key: blank().key }, ...all.slice(i + 1)])); setMenu(null); };

  const matches = slash.startsWith("/") ? TYPES.filter((t) => t.label.toLowerCase().includes(slash.slice(1).trim().toLowerCase()) || t.k.startsWith(slash.slice(1).trim().toLowerCase())) : [];

  return (
    <div className="nb">
      <input className="nb-title" value={title} maxLength={120} placeholder="Untitled test" aria-label="Title" onChange={(e) => setTitle(e.target.value)} />
      <div className="nb-props">
        <label><span>Type</span><select value={kind} onChange={(e) => setKind(e.target.value)}>{kinds.map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select></label>
        <label className="nb-check"><input type="checkbox" checked={showAnswers} onChange={(e) => setShowAnswers(e.target.checked)} /> <span>Show correct answers after hand-in</span></label>
      </div>
      <textarea className="nb-auto nb-instr" rows={2} maxLength={1000} value={instructions} placeholder="Instructions for learners, for example: Answer all questions. Due Friday." aria-label="Instructions for learners" onChange={(e) => setInstructions(e.target.value)} />

      {aiSlot}

      {qs.length === 0 && <p className="nb-empty">Empty page. Ask the AI above, or add your first question below.</p>}

      {qs.map((q, i) => (
        <div key={q.key} className={"nb-block" + (drag?.over === i && drag.from !== i ? " dropping" : "")}
          onDragOver={(e) => { if (drag) { e.preventDefault(); if (drag.over !== i) setDrag({ ...drag, over: i }); } }}
          onDrop={(e) => { e.preventDefault(); if (drag) move(drag.from, i); setDrag(null); }}>
          <div className="nb-gutter">
            <button className="nb-g" aria-label={`Add a question after question ${i + 1}`} title="Add below" onClick={() => setMenu(menu?.type === "add" && menu.at === i + 1 ? null : { type: "add", at: i + 1 })}>+</button>
            <span className="nb-g nb-handle" draggable aria-label={`Drag question ${i + 1} to move it`} title="Drag to move"
              onDragStart={(e) => { setDrag({ from: i, over: i }); e.dataTransfer.effectAllowed = "move"; const el = (e.currentTarget as HTMLElement).closest(".nb-block"); if (el) e.dataTransfer.setDragImage(el, 10, 10); }}
              onDragEnd={() => setDrag(null)}>⠿</span>
          </div>

          <div className="nb-body">
            <div className="nb-head">
              <span className="nb-num">{i + 1}</span>
              <span className="nb-kind">{TYPES.find((t) => t.k === q.kind)?.label}</span>
              <input className="nb-topic" value={q.topic} maxLength={40} placeholder="Topic" aria-label={`Topic of question ${i + 1}`} title="Topic (groups the results)" onChange={(e) => patch(i, { topic: e.target.value })} />
              <button className="nb-g nb-more" aria-label={`Options for question ${i + 1}`} aria-expanded={menu?.type === "block" && menu.at === i} onClick={() => setMenu(menu?.type === "block" && menu.at === i ? null : { type: "block", at: i })}>⋮</button>
            </div>

            {menu?.type === "block" && menu.at === i && (
              <div className="nb-menu" role="menu">
                <p>Turn into</p>
                {TYPES.filter((t) => t.k !== q.kind).map((t) => <button key={t.k} role="menuitem" onClick={() => { patch(i, { kind: t.k }); setMenu(null); }}>{t.icon} {t.label}</button>)}
                <hr />
                <button role="menuitem" onClick={() => duplicate(i)}>⧉ Duplicate</button>
                <button role="menuitem" disabled={i === 0} onClick={() => { move(i, i - 1); setMenu(null); }}>↑ Move up</button>
                <button role="menuitem" disabled={i === qs.length - 1} onClick={() => { move(i, i + 1); setMenu(null); }}>↓ Move down</button>
                <button role="menuitem" className="danger" onClick={() => remove(i)}>✕ Delete</button>
              </div>)}

            <Auto className="nb-q" value={q.text} max={400} placeholder="Write the question…" dataQ={q.key} onChange={(v) => patch(i, { text: v })} />

            {q.kind === "choice" && (
              <div className="nb-opts">
                {q.options.map((o, j) => (
                  <div className="nb-opt" key={j}>
                    <button className={"nb-radio" + (q.answer === j ? " on" : "")} role="radio" aria-checked={q.answer === j} aria-label={`Option ${j + 1} is the correct answer`} title="Mark as correct" onClick={() => patch(i, { answer: j })}>{q.answer === j ? "✓" : ""}</button>
                    <input data-o={`${q.key}-${j}`} value={o} maxLength={300} placeholder={`Option ${j + 1}`}
                      onChange={(e) => patch(i, { options: q.options.map((x, k) => (k === j ? e.target.value : x)) })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); if (q.options.length < 6) { patch(i, { options: [...q.options.slice(0, j + 1), "", ...q.options.slice(j + 1)], answer: q.answer > j ? q.answer + 1 : q.answer }); focusLater(`[data-o="${q.key}-${j + 1}"]`); } }
                        if (e.key === "Backspace" && !o && q.options.length > 2) { e.preventDefault(); patch(i, { options: q.options.filter((_, k) => k !== j), answer: q.answer === j ? 0 : q.answer > j ? q.answer - 1 : q.answer }); focusLater(`[data-o="${q.key}-${Math.max(0, j - 1)}"]`); }
                      }} />
                  </div>))}
                {q.options.length < 6 && <button className="nb-add" onClick={() => patch(i, { options: [...q.options, ""] })}>+ Add an option</button>}
                <p className="nb-tip">Click the circle to mark the correct answer. Press Enter for a new option.</p>
              </div>)}

            {q.kind === "order" && (
              <div className="nb-opts">
                <p className="nb-tip">Type the steps in the <b>correct</b> order. Learners will see them mixed up.</p>
                {q.steps.map((o, j) => (
                  <div className="nb-opt" key={j}>
                    <span className="nb-step">{j + 1}</span>
                    <input data-o={`${q.key}-${j}`} value={o} maxLength={300} placeholder={`Step ${j + 1}`}
                      onChange={(e) => patch(i, { steps: q.steps.map((x, k) => (k === j ? e.target.value : x)) })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); if (q.steps.length < 8) { patch(i, { steps: [...q.steps.slice(0, j + 1), "", ...q.steps.slice(j + 1)] }); focusLater(`[data-o="${q.key}-${j + 1}"]`); } }
                        if (e.key === "Backspace" && !o && q.steps.length > 3) { e.preventDefault(); patch(i, { steps: q.steps.filter((_, k) => k !== j) }); focusLater(`[data-o="${q.key}-${Math.max(0, j - 1)}"]`); }
                      }} />
                  </div>))}
                {q.steps.length < 8 && <button className="nb-add" onClick={() => patch(i, { steps: [...q.steps, ""] })}>+ Add a step</button>}
              </div>)}

            {q.kind === "explain" && (
              <div className="nb-callout"><b>✓ Marking guide</b> <small>(what a correct answer must say. Learners never see it before handing in.)</small>
                <Auto value={q.expected} max={1000} placeholder="Write what a correct answer must include…" onChange={(v) => patch(i, { expected: v })} /></div>)}

            <Auto className="nb-why" value={q.why} max={500} placeholder="Add an explanation learners see after hand-in (optional)" onChange={(v) => patch(i, { why: v })} />
            {menu?.type === "add" && menu.at === i + 1 && <TypeChips onPick={(k) => insert(i + 1, k)} />}
          </div>
        </div>))}

      <div className="nb-addrow">
        <input value={slash} placeholder={qs.length >= 100 ? "100 questions is the limit" : "Type / to add a question, or choose below"} disabled={qs.length >= 100} aria-label="Add a block. Type a slash for commands."
          onChange={(e) => setSlash(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && matches[0]) { e.preventDefault(); insert(qs.length, matches[0].k); } if (e.key === "Escape") setSlash(""); }} />
        {matches.length > 0 && <div className="nb-menu nb-slash" role="listbox">{matches.map((t) => <button key={t.k} role="option" aria-selected={false} onClick={() => insert(qs.length, t.k)}><span aria-hidden="true">{t.icon}</span> <b>{t.label}</b> <small>{t.hint}</small></button>)}</div>}
        {qs.length < 100 && <TypeChips onPick={(k) => insert(qs.length, k)} />}
        <p className="nb-count">{qs.length} of 100 questions</p>
      </div>
    </div>
  );
}
