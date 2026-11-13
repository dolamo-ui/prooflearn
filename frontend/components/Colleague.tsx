"use client";
import { useEffect, useRef, useState } from "react";
import type { Level } from "../lib/agent";
import { readFileText } from "../lib/client";
import { MAX_STEPS_DEFAULT } from "../lib/colleague";
import { AGENTS, agentById, handoffLine, ledgerLine, type AgentEvent, type AgentId, type Outcome } from "../lib/agents";
import { runAgents } from "../lib/runAgents";
import { downloadHtmlPdf, safeName, saveBlob, wordPage } from "../lib/pdf";
import { shareUrl } from "../lib/share";
import { answerText } from "./App";
import ShareBox from "./ShareBox";
import { CopyButton, HowTo, Msg, NotePicker, PasscodeBox, Page } from "./ui";

/* The autonomous colleague (screen).
   The work happens in lib/runAgents.ts: runAgents(goal, state) streams events (lib/agents.ts defines them).
   This file only READS those events and shows them two ways: as lanes (one column per agent) or as one list.
   The person sets the goal and presses Start. They can press Stop at any time. */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const peer = (e: AgentEvent) => e.type === "handoff" && e.handoff.kind !== "task" && e.handoff.kind !== "result";

/* ---------------- one event -> one card ---------------- */
type Card = {
  id: number;
  lane: AgentId;               // whose lane it sits in
  cls: string;                 // the colour the manual screens already use (see design.css: plan, adapt, tool, mark, critic, fix)
  label: string;               // Goal, Plan, Thinking, Doing, Result, Found, Hand-off, Note, Done
  text: string;
  sub?: string;                // a small second line (lanes view only)
};

const cardOf = (e: AgentEvent): Card | null => {
  switch (e.type) {
    case "goal": return { id: e.seq, lane: "coordinator", cls: "plan", label: "Goal", text: e.text };
    case "plan": return { id: e.seq, lane: "coordinator", cls: "plan", label: "Plan", text: e.steps.map((p, i) => `${i + 1}. ${p}`).join("   ") };
    case "think": return { id: e.seq, lane: e.agent, cls: "adapt", label: "Thinking", text: e.text };
    case "act": return { id: e.seq, lane: e.agent, cls: "tool", label: "Doing", text: e.text, sub: "Task from the Coordinator" };
    case "result": return e.ok
      ? { id: e.seq, lane: e.agent, cls: e.tool === "check_questions" ? "critic" : "mark", label: "Result", text: e.text }
      : { id: e.seq, lane: e.agent, cls: "critic", label: "Note", text: e.text };
    case "finding": return { id: e.seq, lane: e.agent, cls: "critic", label: "Found", text: e.text };
    case "handoff": return peer(e) ? { id: e.seq, lane: e.handoff.from, cls: "hand", label: "Hand-off", text: `→ ${agentById(e.handoff.to).name}: ${e.handoff.subject}`, sub: e.handoff.body } : null;
    case "note": return { id: e.seq, lane: e.agent, cls: e.level === "warn" ? "critic" : "tool", label: "Note", text: e.text };
    case "done": return { id: e.seq, lane: e.agent, cls: "fix", label: "Done", text: e.text };
    default: return null;
  }
};

function Chip({ id }: { id: AgentId }) {
  return <span className="agent-chip" data-agent={id}>{agentById(id).name}</span>;
}

/** The log as one list, oldest first, with the agent named on every line. */
function ListView({ cards }: { cards: Card[] }) {
  return <>{cards.map((t) => (
    <p key={t.id} className={"ln " + t.cls}><b>{t.label}</b> {t.label !== "Goal" && <Chip id={t.lane} />} {t.text}{t.label === "Hand-off" && t.sub ? <small className="ln-sub"> {t.sub}</small> : null}</p>
  ))}</>;
}

/** The log as lanes: one column per agent that has taken part. Time runs downward. */
function LaneView({ cards }: { cards: Card[] }) {
  const lanes = AGENTS.filter((a) => a.id === "coordinator" || cards.some((c) => c.lane === a.id));
  return (
    <div className="lanes" style={{ ["--cols" as string]: lanes.length } as React.CSSProperties}>
      <div className="lane-row lane-head" aria-hidden="true">
        {lanes.map((a) => <div key={a.id} className="lane-name" data-agent={a.id} title={a.job}>{a.name}</div>)}
      </div>
      {cards.map((t) => (
        <div key={t.id} className="lane-row">
          <div className={"lane-card ln " + t.cls} data-agent={t.lane} style={{ gridColumn: lanes.findIndex((a) => a.id === t.lane) + 1 }}>
            <span className="visually-hidden">{agentById(t.lane).name}: </span>
            <b>{t.label}</b> {t.text}
            {t.sub && <small className="lane-sub">{t.sub}</small>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** "Who did what", for the screen. The same words go into the PDF and Word report (see reportHtml). */
function WhoDidWhat({ o }: { o: Outcome }) {
  const between = o.handoffs.filter((h) => h.kind !== "task" && h.kind !== "result");
  return (
    <details className="src" open><summary>Who did what: {o.ledger.length} agent{o.ledger.length === 1 ? "" : "s"}, {o.handoffs.length} hand-off{o.handoffs.length === 1 ? "" : "s"}</summary>
      <p>{o.headline}</p>
      <ul className="ledger">{o.ledger.map((r) => <li key={r.agent} data-agent={r.agent}>{ledgerLine(r)}{r.notes.length > 0 && <small> {r.notes.join(" · ")}</small>}</li>)}</ul>
      {between.length > 0 && (
        <>
          <p><b>Hand-offs between specialists</b></p>
          <ol className="ledger">{between.map((h) => <li key={h.id}>{handoffLine(h)}{h.body ? <small> {h.body}</small> : null}</li>)}</ol>
        </>
      )}
    </details>
  );
}

const reportHtml = (o: Outcome) => {
  const p = o.plan;
  const list = (xs: string[]) => `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
  return `<h1>${esc(o.course?.title || "Colleague report")}</h1>` +
    `<h2>Report</h2><p>${esc(o.summary)}</p>` +
    `<h2>Who did what</h2><p>${esc(o.headline)}</p><ul>${o.ledger.map((r) => `<li>${esc(ledgerLine(r))}${r.notes.length ? ` ${esc(r.notes.join("; "))}.` : ""}</li>`).join("")}</ul>` +
    (o.handoffs.some((h) => h.kind !== "task" && h.kind !== "result") ? `<h3>Hand-offs between specialists</h3><ol>${o.handoffs.filter((h) => h.kind !== "task" && h.kind !== "result").map((h) => `<li>${esc(handoffLine(h))}${h.body ? ` ${esc(h.body)}` : ""}</li>`).join("")}</ol>` : "") +
    (o.course ? `<h2>Lessons</h2>${o.course.lessons.map((l) => `<h3>${esc(l.title)}</h3><p>${esc(l.explain)}</p>${list(l.keyPoints)}<p><b>Example:</b> ${esc(l.example)}</p>`).join("")}` : "") +
    (o.questions.length ? `<h2>Test${o.approved ? " (approved by the checker)" : " (NOT approved by the checker)"}</h2><ol>${o.questions.map((q) => `<li>${esc(q.text)}${q.kind === "choice" ? ` Options: ${esc(q.options.join(" / "))}.` : q.kind === "order" ? ` Steps: ${esc(q.options.join(" / "))}.` : ""} <b>Answer:</b> ${esc(answerText(q))}</li>`).join("")}</ol>` : "") +
    (o.sources.length ? `<h2>Sources</h2><p>Found by web search. Only a short snippet of each page was read, so please open them and check before you rely on them.</p><ol>${o.sources.map((h) => `<li>${esc(h.title)} — ${esc(h.url)}</li>`).join("")}</ol>` : "") +
    (o.shared ? `<h2>Shared test</h2><p>${esc(o.shared.title)}. Code: <b>${esc(o.shared.code)}</b>. Link: ${esc(shareUrl(o.shared.code))}</p>` : "") +
    (o.results ? `<h2>Class results</h2><p>${esc(o.results.title)}: ${o.results.count} handed in${o.results.count ? `, class average ${o.results.average}%${o.results.weak.length ? `. Topics to teach again: ${esc(o.results.weak.join(", "))}` : ""}` : ""}.</p>` : "") +
    (o.emails.length ? `<h2>Email drafts (not sent)</h2>${o.emails.map((m) => `<h3>To ${esc(m.to)}: ${esc(m.subject)}</h3>${m.body.split(/\n{2,}/).map((para) => `<p>${esc(para).replace(/\n/g, "<br/>")}</p>`).join("")}`).join("")}` : "") +
    (p ? `<h2>Lesson plan (${p.durationMinutes} minutes)</h2><p>${esc(p.alignment)}</p><ol>${p.steps.map((s) => `<li>${s.minutes} min — ${esc(s.stage)}. Teacher: ${esc(s.teacherAction)} Student: ${esc(s.studentAction)}</li>`).join("")}</ol><h3>Checks for understanding</h3>${list(p.checksForUnderstanding)}<h3>Coaching: try next</h3>${list(p.coaching.tryNext)}` : "");
};

/* ---------------- the screen ---------------- */
const EXAMPLE = "Prepare a 40-minute lesson on photosynthesis for Grade 9 from my notes, with a short test I can trust.";

export default function Colleague({ onBack, passcode, setPasscode }: { onBack: () => void; passcode: string; setPasscode: (v: string) => void }) {
  const [goal, setGoal] = useState("");
  const [noteId, setNoteId] = useState("");
  const [notes, setNotes] = useState("");
  const [level, setLevel] = useState<Level>("Intermediate");
  const [maxSteps, setMaxSteps] = useState(MAX_STEPS_DEFAULT);
  const [allowShare, setAllowShare] = useState(false);
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [view, setView] = useState<"lanes" | "list">("lanes");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState("");
  const [fileNote, setFileNote] = useState("");
  const stop = useRef(false);
  const alive = useRef(true);
  const runId = useRef(0);
  const box = useRef<HTMLDivElement>(null);

  // React's dev mode mounts, unmounts and mounts again, so "alive" must be switched back on here.
  useEffect(() => { alive.current = true; return () => { alive.current = false; stop.current = true; }; }, []);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [events]);
  // Six lanes will not fit on a phone, so a narrow screen starts on the one-list view (the person can still switch).
  useEffect(() => { try { if (window.matchMedia("(max-width: 700px)").matches) setView("list"); } catch { /* keep the default */ } }, []);

  const upload = async (f: File | undefined) => {
    if (!f) return;
    setError("");
    try { setNotes((await readFileText(f)).slice(0, 20000)); setNoteId(""); } catch (e: any) { setError(e.message); }
  };

  const start = async () => {
    setError(""); setFileNote("");
    const g = goal.trim();
    if (g.length < 8) return setError("Tell your colleague what you want done, in a sentence or two.");
    const me = ++runId.current;
    stop.current = false;
    setRunning(true); setOutcome(null); setEvents([]);
    const current = () => alive.current && me === runId.current;
    try {
      // The screen only reads events. The runner could be swapped for another one without touching this loop.
      for await (const ev of runAgents(g, { notes, level, maxSteps, canShare: allowShare, passcode, shouldStop: () => stop.current })) {
        if (!current()) break;
        if (ev.type === "end") setOutcome(ev.outcome);
        else if (ev.type === "error") setError(ev.text);
        else setEvents((p) => [...p, ev]);
      }
    } catch (e: any) {
      if (current()) setError(e?.message || "Something went wrong. Please try again.");
    } finally {
      if (current()) setRunning(false);
    }
  };

  const title = outcome?.course?.title || "Colleague report";
  const wordFile = () => {
    if (!outcome) return;
    saveBlob(new Blob([wordPage(title, reportHtml(outcome))], { type: "application/msword" }), `${safeName(title, "colleague-report")}.doc`);
    setFileNote("Word file downloaded.");
  };
  const pdfFile = async () => {
    if (!outcome) return;
    try {
      const r = await downloadHtmlPdf(`${safeName(title, "colleague-report")}.pdf`, title, reportHtml(outcome));
      setFileNote(r.lossy ? "PDF downloaded. A few special characters cannot be shown in a PDF and appear as “?”. Use the Word download to keep them." : "PDF downloaded.");
    } catch { setFileNote("I could not make the PDF. Try the Word download instead."); }
  };

  return (
    <Page title="Digital colleague" onBack={onBack} backLabel="Teacher"
      help="Give your colleague a goal and press Start. It decides what to do, does it, checks its own work, and tells you what it made. You watch every step and can stop it.">
      {!running && !outcome && (
        <>
          <HowTo steps={["Describe what you want done. Be as specific as you like (grade, length, test size).", "Optionally give it your notes. It will read them before it builds anything.", "Press Start. Watch the log, and press Stop if you want to take over."]} />
          <label className="answer-field"><span>What do you want your colleague to do?</span>
            <textarea rows={3} maxLength={500} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={EXAMPLE} />
            <small><button className="link" type="button" onClick={() => setGoal(EXAMPLE)}>Use an example</button></small>
          </label>
          <NotePicker role="teacher" value={noteId} onChange={(id, n) => { setNoteId(id); setNotes(n?.body || ""); }} />
          <label className="answer-field"><span>…or upload notes <small>(PDF, Word, .txt)</small></span>
            <input type="file" accept=".pdf,.docx,.txt,.md,.csv" onChange={(e) => upload(e.target.files?.[0])} />
            {notes && <small>{notes.length.toLocaleString()} characters of notes ready. <button className="link" type="button" onClick={() => { setNotes(""); setNoteId(""); }}>Remove</button></small>}
          </label>
          <label className="answer-field"><span>
            <input type="checkbox" checked={allowShare} onChange={(e) => setAllowShare(e.target.checked)} /> Let my colleague share the finished test with learners
          </span>
            <small>Off by default. When on, it may publish the test, but only after the checker passes it with no changes. Anyone with the code can open it. Email drafts are never sent either way: you copy them or open them in your own email app.</small>
          </label>
          {allowShare && <PasscodeBox value={passcode} onChange={setPasscode} />}
          <details className="src"><summary>More options (you can skip these)</summary>
            <label className="answer-field"><span>Learner level</span>
              <select value={level} onChange={(e) => setLevel(e.target.value as Level)}><option value="Beginner">Beginner</option><option value="Intermediate">Intermediate</option><option value="Advanced">Advanced</option></select>
            </label>
            <label className="answer-field"><span>Most steps it may take</span>
              <select value={maxSteps} onChange={(e) => setMaxSteps(Number(e.target.value))}>{[6, 8, 10, 12, 14].map((n) => <option key={n} value={n}>{n} steps{n === MAX_STEPS_DEFAULT ? " (recommended)" : ""}</option>)}</select>
              <small>A safety limit. Every step is one AI decision plus one piece of work.</small>
            </label>
          </details>
          <button className="btn" onClick={start}>Start</button>
          <Msg error={error} />
        </>
      )}

      {(running || outcome) && (
        <section className="trace colleague-log" aria-label="What your colleague is doing">
          <h3>{running ? "Your colleague is working…" : outcome?.stopped ? "Stopped" : "Finished"}</h3>
          <div className="view-toggle" role="group" aria-label="How to show the log">
            <button type="button" className={view === "lanes" ? "btn" : "ghost"} aria-pressed={view === "lanes"} onClick={() => setView("lanes")}>Agent lanes</button>
            <button type="button" className={view === "list" ? "btn" : "ghost"} aria-pressed={view === "list"} onClick={() => setView("list")}>One list</button>
          </div>
          <div className="log" ref={box} aria-live="polite">
            {(() => {
              const cards = events.map(cardOf).filter((x): x is NonNullable<typeof x> => !!x);
              return view === "lanes" ? <LaneView cards={cards} /> : <ListView cards={cards} />;
            })()}
            {running && <p className="ln tool"><span className="spin" aria-hidden="true" /></p>}
          </div>
          {running && <button className="ghost" onClick={() => { stop.current = true; }}>Stop after this step</button>}
        </section>
      )}
      {running && <Msg error={error} />}

      {outcome && !running && (
        <>
          <Msg error={error} />
          <h3>Report</h3>
          <p className="note-ok">{outcome.summary}</p>
          {outcome.questions.length > 0 && !outcome.approved && <p className="warn">This test was <b>not</b> approved by the checker. Read every question carefully before you use it.</p>}
          <WhoDidWhat o={outcome} />
          {outcome.course && (
            <details className="src" open><summary>{outcome.course.lessons.length} lessons: {outcome.course.title}</summary>
              <ol>{outcome.course.lessons.map((l) => <li key={l.topic}><b>{l.title}</b> — {l.objective}</li>)}</ol>
            </details>
          )}
          {outcome.questions.length > 0 && (
            <details className="src" open><summary>{outcome.questions.length}-question test {outcome.approved ? "(approved by the checker)" : "(not approved)"}</summary>
              <ol>{outcome.questions.map((q) => <li key={q.id}>{q.text} <small>— answer: <b>{answerText(q)}</b></small></li>)}</ol>
            </details>
          )}
          {outcome.shared && (
            <details className="src" open><summary>Shared test: {outcome.shared.title}</summary>
              <ShareBox code={outcome.shared.code} title={outcome.shared.title} what="test" />
              <p><small>You can see who handed in under Tests and classwork → Results.</small></p>
            </details>
          )}
          {outcome.results && (
            <details className="src" open><summary>Class results: {outcome.results.title}</summary>
              <p>{outcome.results.count ? <>{outcome.results.count} handed in. Class average <b>{outcome.results.average}%</b>.{outcome.results.weak.length ? <> Topics to teach again: <b>{outcome.results.weak.join(", ")}</b>.</> : " No topic is under 70%."}</> : "Nobody has handed this in yet."}</p>
              <p><small>Learner names and written answers are on Tests and classwork → Results. Your colleague only saw the totals.</small></p>
            </details>
          )}
          {outcome.emails.map((m, i) => {
            const full = `Subject: ${m.subject}\n\n${m.body}`;
            const mailto = `mailto:?subject=${encodeURIComponent(m.subject)}&body=${encodeURIComponent(m.body)}`;
            return (
              <details className="src" open key={i}><summary>Email draft to {m.to}: {m.subject}</summary>
                <p className="warn"><b>Draft only. Nothing was sent.</b> Read it, fill in the [ ] gaps, add the people you are writing to, then send it yourself.</p>
                <pre style={{ whiteSpace: "pre-wrap", font: "inherit" }}>{m.body}</pre>
                <div className="actions">
                  <CopyButton text={full} label="Copy email" />
                  {mailto.length < 1800 ? <a className="ghost" href={mailto}>Open in my email app</a> : <small>Too long to open in an email app. Use Copy.</small>}
                </div>
              </details>
            );
          })}
          {outcome.sources.length > 0 && (
            <details className="src" open><summary>{outcome.sources.length} web source{outcome.sources.length > 1 ? "s" : ""}</summary>
              <p><small>Only a short snippet of each page was read. Open them and check before you rely on them.</small></p>
              <ol>{outcome.sources.map((h) => <li key={h.url}><a href={h.url} target="_blank" rel="noopener noreferrer">{h.title}</a> <small>({new URL(h.url).hostname})</small></li>)}</ol>
            </details>
          )}
          {outcome.plan && (
            <details className="src" open><summary>{outcome.plan.durationMinutes}-minute lesson plan</summary>
              <ol className="plan-steps">{outcome.plan.steps.map((s, i) => <li key={i}><b>{s.minutes} min · {s.stage}</b> Teacher: {s.teacherAction} <b>Learners:</b> {s.studentAction}</li>)}</ol>
            </details>
          )}
          <div className="actions">
            <button className="btn" onClick={pdfFile}>Download report (PDF)</button>
            <button className="btn" onClick={wordFile}>Download report (Word)</button>
            <button className="ghost" onClick={() => { setOutcome(null); setEvents([]); }}>Give it another goal</button>
          </div>
          {fileNote && <p className="note-ok">{fileNote}</p>}
        </>
      )}
    </Page>
  );
}
