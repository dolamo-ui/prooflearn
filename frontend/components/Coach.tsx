"use client";
import { useEffect, useRef, useState } from "react";
import { score, type Course, type Finding, type Lesson, type Level, type Question, type TestAnswer } from "../lib/agent";
import { api, readFileText } from "../lib/client";
import {
  COACH_STEPS_DEFAULT, TARGET, isMastered, weakTopics,
  type CoachDecision, type CoachObservation, type CoachSnapshot, type CoachTool, type Knows,
} from "../lib/coach";
import { downloadHtmlPdf, safeName, saveBlob, wordPage } from "../lib/pdf";
import { Quiz, answerText } from "./App";
import { HowTo, Msg, NotePicker, Page } from "./ui";

/* The autonomous learning coach (browser side).
   The LOOP lives here; the DECISIONS come from the AI (/api/coach). Unlike the teacher's colleague, the learner takes part:
   when the coach shows a lesson or a test, the loop WAITS for the learner, then carries on with what it learned.
   Marking is done by code (exact match for choice/order, the existing signed-key grader for written answers), never by the coach's decision. */

type Kind = "goal" | "plan" | "think" | "act" | "result" | "check" | "warn" | "done";
type Ev = { id: number; kind: Kind; text: string };
type Round = { n: number; right: number; total: number; pct: Record<string, number> };
type Ctx = {
  goal: string; level: Level; knows: Knows; notes: string; course: Course | null;
  taught: Record<string, number>; unsure: Set<string>; scores: Record<string, number>;
  rounds: Round[]; taughtSinceQuiz: number; asked: string[];
};
type Result = { round: number; qs: Question[]; ans: TestAnswer[]; grades: (boolean | undefined)[]; feedback: Record<string, string>; right: number; pct: Record<string, number> };
type Pending =
  | { kind: "read"; lesson: Lesson; times: number }
  | { kind: "quiz"; round: number; qs: Question[] }
  | { kind: "marking" }
  | { kind: "result"; result: Result }
  | null;
type Outcome = { course: Course | null; scores: Record<string, number>; rounds: Round[]; mastered: boolean; message: string; stopped: boolean };
type Say = (kind: Kind, text: string) => void;
type IO = {
  say: Say;
  read: (lesson: Lesson, times: number) => Promise<boolean>;
  quiz: (round: number, qs: Question[]) => Promise<TestAnswer[]>;
  marking: () => void;
  show: (r: Result) => Promise<void>;
};

class Stopped extends Error {}
const LABEL: Record<Kind, string> = { goal: "Goal", plan: "Plan", think: "Coach", act: "Doing", result: "Result", check: "Marked", warn: "Note", done: "Done" };
const CLASS: Record<Kind, string> = { goal: "plan", plan: "plan", think: "adapt", act: "tool", result: "mark", check: "fix", warn: "critic", done: "fix" };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const agent = <T,>(action: string, body: object) => api<T>("/api/agent", { action, ...body });
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const answered = (a: TestAnswer) => (typeof a === "number" ? a >= 0 : typeof a === "string" ? !!a.trim() : Array.isArray(a));

/* ---------------- marking: always code, never the coach ---------------- */
async function mark(qs: Question[], ans: TestAnswer[], c: Ctx): Promise<{ grades: (boolean | undefined)[]; feedback: Record<string, string> }> {
  const written = qs.flatMap((q, i) => q.kind === "explain" ? [{ id: q.id, text: q.text, expectedAnswer: q.expectedAnswer, sig: q.sig, response: typeof ans[i] === "string" ? ans[i] : "" }] : []);
  if (!written.length) return { grades: qs.map(() => undefined), feedback: {} };
  let last: any;
  for (let attempt = 0; attempt < 2; attempt++) {          // one quiet retry, so a small hiccup does not lose the learner's answers
    try {
      const r = await agent<{ grades: { id: string; correct: boolean; feedback: string }[] }>("grade", { course: c.course, source: c.notes, responses: written });
      const by = new Map(r.grades.map((g) => [g.id, g]));
      if (written.some((w) => !by.has(w.id))) throw new Error("The AI did not mark every written answer.");
      return { grades: qs.map((q) => (q.kind === "explain" ? by.get(q.id)!.correct : undefined)), feedback: Object.fromEntries(r.grades.map((g) => [g.id, g.feedback])) };
    } catch (e) { last = e; await sleep(1500); }
  }
  throw last;
}

/* ---------------- the tools ---------------- */
type Runner = (a: CoachDecision["args"], c: Ctx, io: IO) => Promise<string>;
const RUNNERS: Record<Exclude<CoachTool, "finish">, Runner> = {
  async build_lessons(a, c) {
    const topic = str(a.topic, 200) || c.goal.slice(0, 200);
    const start = c.knows === "nothing" ? " Learner is a complete beginner." : c.knows === "a lot" ? " Learner already knows a lot." : " Learner knows a little already.";
    const outcome = (str(a.outcome, 300) || c.goal.slice(0, 300)).slice(0, 300 - start.length) + start;
    const { course } = await agent<{ course: Course }>("course", { goal: topic, outcome, level: c.level, source: c.notes });
    c.course = course; c.taught = {}; c.unsure = new Set(); c.scores = {}; c.rounds = []; c.taughtSinceQuiz = 0; c.asked = [];
    return `Prepared ${course.lessons.length} topics: ${course.lessons.map((l) => l.topic).join(", ")}.`;
  },

  async teach_topic(a, c, io) {
    const lesson = c.course?.lessons.find((l) => l.topic.toLowerCase() === a.topic.toLowerCase());
    if (!lesson) throw new Error("That topic is not in the course.");
    const times = c.taught[lesson.topic] || 0;
    const understood = await io.read(lesson, times);
    c.taught[lesson.topic] = times + 1;
    c.taughtSinceQuiz++;
    if (understood) c.unsure.delete(lesson.topic); else c.unsure.add(lesson.topic);
    return `Showed "${lesson.topic}" (${times ? `a different explanation, time ${times + 1}` : "first time"}). The learner said: ${understood ? "I understand" : "still unsure"}.`;
  },

  async quiz_learner(_a, c, io) {
    if (!c.course) throw new Error("There are no lessons yet.");
    const first = c.rounds.length === 0;
    const weak = c.course.lessons.map((l) => l.topic).filter((t) => c.scores[t] !== undefined && c.scores[t] < TARGET);
    let qs: Question[];
    if (first) {
      const d = await agent<{ questions: Question[] }>("draft", { course: c.course, level: c.level, source: c.notes });
      const r = await agent<{ questions: Question[]; findings: Finding[] }>("review", { course: c.course, level: c.level, source: c.notes, questions: d.questions });
      qs = r.questions;                                      // only questions the checker approved reach the learner
    } else {
      if (!weak.length) throw new Error("There are no weak topics to test.");
      qs = (await agent<{ questions: Question[] }>("retest", { course: c.course, level: c.level, source: c.notes, topics: weak, previous: c.asked.slice(-20) })).questions;
    }
    c.asked.push(...qs.map((q) => q.text));
    const round = c.rounds.length + 1;
    const ans = await io.quiz(round, qs);
    io.marking();
    const { grades, feedback } = await mark(qs, ans, c);
    const r = score(qs, ans, grades);
    for (const [t, p] of Object.entries(r.pct)) c.scores[t] = p;
    c.rounds.push({ n: round, right: r.right, total: qs.length, pct: r.pct });
    c.taughtSinceQuiz = 0;
    io.say("check", `${r.right} of ${qs.length} correct. ${Object.entries(r.pct).map(([t, p]) => `${t} ${p}%`).join(", ")}.`);
    await io.show({ round, qs, ans, grades, feedback, right: r.right, pct: r.pct });
    const weakNow = Object.entries(r.pct).filter(([, p]) => p < TARGET).map(([t]) => t);
    return `Round ${round}: ${r.right} of ${qs.length} correct (marked by code). Scores: ${Object.entries(r.pct).map(([t, p]) => `${t} ${p}%`).join(", ")}. ${weakNow.length ? `Below ${TARGET}%: ${weakNow.join(", ")}.` : `Every topic tested is at ${TARGET}% or more.`}`;
  },
};

const snapshot = (c: Ctx, uses: CoachSnapshot["uses"], failures: number): CoachSnapshot => ({
  knows: c.knows, lessons: c.course?.lessons.map((l) => l.topic) || [], taught: { ...c.taught }, unsure: Array.from(c.unsure),
  scores: { ...c.scores }, rounds: c.rounds.length, taughtSinceQuiz: c.taughtSinceQuiz, failures, uses,
});

const codeMessage = (s: CoachSnapshot, stopped: boolean) => {
  if (isMastered(s)) return "You proved it: every topic is at or above the target on marked questions. Well done.";
  if (!s.rounds) return stopped ? "We stopped before the first test, so there is nothing to show yet. You can start again any time." : "We did not get to a test this time. Try again and your coach will pick up from the start.";
  const weak = weakTopics(s);
  return `You are not there yet on: ${weak.join(", ")}. That is normal. Go over those topics again, or ask a teacher or tutor about them, then come back and test yourself.`;
};

const studyHtml = (o: Outcome) => {
  const list = (xs: string[]) => `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
  return `<h1>${esc(o.course?.title || "My study summary")}</h1>` +
    `<h2>${o.mastered ? "Proof: every topic learned" : "Where I am"}</h2>` +
    list(Object.entries(o.scores).map(([t, p]) => `${t}: ${p}% — ${p >= TARGET ? "learned" : "still working on it"}`)) +
    `<h2>My coach says</h2><p>${esc(o.message)}</p>` +
    (o.course ? `<h2>My notes</h2>${o.course.lessons.map((l) => `<h3>${esc(l.title)}</h3><p>${esc(l.explain)}</p>${list(l.keyPoints)}<p><b>Another way to think about it:</b> ${esc(l.retry)}</p>`).join("")}` : "");
};

const EXAMPLE = "I want to understand how email works well enough to pass a short quiz on it.";

/* ---------------- the screen ---------------- */
export default function Coach({ onBack }: { onBack: () => void }) {
  const [goal, setGoal] = useState("");
  const [noteId, setNoteId] = useState("");
  const [notes, setNotes] = useState("");
  const [level, setLevel] = useState<Level>("Beginner");
  const [knows, setKnows] = useState<Knows>("a little");
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<Ev[]>([]);
  const [pending, setPending] = useState<Pending>(null);
  const [vals, setVals] = useState<TestAnswer[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState("");
  const [fileNote, setFileNote] = useState("");
  const stop = useRef(false);
  const alive = useRef(true);
  const runId = useRef(0);
  const nextId = useRef(1);
  const waiter = useRef<((v: any) => void) | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const now = useRef<HTMLDivElement>(null);

  // React's dev mode mounts, unmounts and mounts again, so "alive" must be switched back on here.
  useEffect(() => { alive.current = true; return () => { alive.current = false; stop.current = true; waiter.current?.(new Stopped()); }; }, []);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [events]);
  useEffect(() => { if (pending) now.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }, [pending?.kind]);   // eslint-disable-line react-hooks/exhaustive-deps

  const upload = async (f: File | undefined) => {
    if (!f) return;
    setError("");
    try { setNotes((await readFileText(f)).slice(0, 20000)); setNoteId(""); } catch (e: any) { setError(e.message); }
  };

  const release = (v: any) => waiter.current?.(v);
  const stopNow = () => { stop.current = true; release(new Stopped()); };

  const start = async () => {
    setError(""); setFileNote("");
    const g = goal.trim();
    if (g.length < 5) return setError("Tell your coach what you want to learn, in a short sentence.");
    const me = ++runId.current;
    stop.current = false;
    setRunning(true); setOutcome(null); setEvents([]); setPending(null);
    const live = () => alive.current && me === runId.current;
    const say: Say = (kind, text) => { if (live()) setEvents((p) => [...p, { id: nextId.current++, kind, text }]); };
    // Show something to the learner and wait until they answer. The loop is paused meanwhile.
    const wait = <T,>(p: Pending, resolveWith: (v: any) => T): Promise<T> => new Promise<T>((resolve, reject) => {
      if (stop.current) return reject(new Stopped());
      setPending(p);
      waiter.current = (v) => { waiter.current = null; if (v instanceof Stopped) { setPending(null); reject(v); } else { setPending(null); resolve(resolveWith(v)); } };
    });
    const io: IO = {
      say,
      read: (lesson, times) => wait({ kind: "read", lesson, times }, (v) => v === true),
      quiz: (round, qs) => { setVals(qs.map(() => null)); return wait({ kind: "quiz", round, qs }, (v) => v as TestAnswer[]); },
      marking: () => setPending({ kind: "marking" }),
      show: (r) => wait({ kind: "result", result: r }, () => undefined),
    };

    const c: Ctx = { goal: g, level, knows, notes: notes.trim(), course: null, taught: {}, unsure: new Set(), scores: {}, rounds: [], taughtSinceQuiz: 0, asked: [] };
    const uses: CoachSnapshot["uses"] = {};
    const seen: CoachObservation[] = [];
    const maxSteps = COACH_STEPS_DEFAULT;
    let failures = 0, plan: string[] = [], message = "", stopped = false;

    say("goal", g);
    try {
      for (let step = 1; step <= maxSteps + 1; step++) {
        if (stop.current) { stopped = true; break; }
        const { decision: d } = await api<{ decision: CoachDecision }>("/api/coach", {
          goal: g, level, maxSteps, step, snapshot: snapshot(c, uses, failures), observations: seen.slice(-8), plan,
        });
        if (stop.current) { stopped = true; break; }
        if (d.plan.length) { plan = d.plan; say("plan", d.plan.map((p, i) => `${i + 1}. ${p}`).join("   ")); }
        if (d.fallback) say("warn", d.fallback);
        say("think", d.thought);
        if (d.action === "finish") { message = str(d.args.summary, 900); break; }
        uses[d.action] = (uses[d.action] || 0) + 1;
        say("act", d.action === "build_lessons" ? "Getting your topics ready…" : d.action === "teach_topic" ? `Showing you: ${d.args.topic}` : "Getting your test ready…");
        try {
          const text = await RUNNERS[d.action](d.args, c, io);
          failures = 0;
          seen.push({ step, action: d.action, ok: true, text });
          if (d.action === "build_lessons") say("result", text);
        } catch (e: any) {
          if (e instanceof Stopped) { stopped = true; break; }
          failures++;
          const msg = String(e?.message || "That step failed.").slice(0, 200);
          seen.push({ step, action: d.action, ok: false, text: msg });
          say("warn", `That step did not work: ${msg}`);
          if (failures >= 3) { say("warn", "Three steps in a row failed, so I am stopping here."); break; }
        }
      }
    } catch (e: any) {
      if (live() && !(e instanceof Stopped)) setError(e?.message || "Something went wrong. Please try again.");
      if (e instanceof Stopped) stopped = true;
    } finally {
      if (live()) {
        const snap = snapshot(c, uses, failures);
        // Whether the learner "learned it" comes from the marks, in code. The coach's words are only a note.
        const mastered = isMastered(snap);
        if (stopped) say("warn", "Stopped. Here is where you got to.");
        setOutcome({
          course: c.course, scores: { ...c.scores }, rounds: c.rounds, mastered, stopped,
          message: mastered || !message ? codeMessage(snap, stopped) + (message && mastered ? " " + message : "") : message + " " + codeMessage(snap, stopped),
        });
        setPending(null); setRunning(false);
      }
    }
  };

  const title = outcome?.course?.title || "My study summary";
  const wordFile = () => {
    if (!outcome) return;
    saveBlob(new Blob([wordPage(title, studyHtml(outcome))], { type: "application/msword" }), `${safeName(title, "my-study-summary")}.doc`);
    setFileNote("Word file downloaded.");
  };
  const pdfFile = async () => {
    if (!outcome) return;
    try {
      const r = await downloadHtmlPdf(`${safeName(title, "my-study-summary")}.pdf`, title, studyHtml(outcome));
      setFileNote(r.lossy ? "PDF downloaded. A few special characters cannot be shown in a PDF and appear as “?”. Use the Word download to keep them." : "PDF downloaded.");
    } catch { setFileNote("I could not make the PDF. Try the Word download instead."); }
  };

  const meters = (pct: Record<string, number>) => (
    <ul className="meters">{Object.entries(pct).map(([t, p]) => (
      <li key={t}><span>{t}</span><span className="mtrack"><span className="mfill" style={{ width: `${p}%` }} /></span><b>{p}%</b></li>
    ))}</ul>
  );

  return (
    <Page title="My learning coach" onBack={onBack} backLabel="Learner"
      help="Tell your coach what you want to learn. It decides what to teach and when to test you, and it only says you learned something when your marked answers prove it.">
      {!running && !outcome && (
        <>
          <HowTo steps={["Say what you want to learn, and how much you already know.", "Press Start. Your coach shows you a topic to read, or a short test, whichever it thinks you need.", "Answer honestly. Weak topics are explained a different way and tested again, until you prove them."]} />
          <label className="answer-field"><span>What do you want to learn and prove?</span>
            <textarea rows={3} maxLength={500} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={EXAMPLE} />
            <small><button className="link" type="button" onClick={() => setGoal(EXAMPLE)}>Use an example</button></small>
          </label>
          <label className="answer-field"><span>How much do you already know about it?</span>
            <select value={knows} onChange={(e) => setKnows(e.target.value as Knows)}>
              <option value="nothing">Nothing yet. Teach me first.</option>
              <option value="a little">A little. Test me first, then teach what I miss.</option>
              <option value="a lot">Quite a lot. Test me first.</option>
            </select>
          </label>
          <NotePicker role="learner" value={noteId} onChange={(id, n) => { setNoteId(id); setNotes(n?.body || ""); }} />
          <label className="answer-field"><span>…or upload your notes <small>(optional: PDF, Word, .txt)</small></span>
            <input type="file" accept=".pdf,.docx,.txt,.md,.csv" onChange={(e) => upload(e.target.files?.[0])} />
            {notes && <small>{notes.length.toLocaleString()} characters of notes ready. <button className="link" type="button" onClick={() => { setNotes(""); setNoteId(""); }}>Remove</button></small>}
          </label>
          <details className="src"><summary>More options (you can skip these)</summary>
            <label className="answer-field"><span>Level</span>
              <select value={level} onChange={(e) => setLevel(e.target.value as Level)}><option value="Beginner">Beginner</option><option value="Intermediate">Intermediate</option><option value="Advanced">Advanced</option></select>
            </label>
          </details>
          <button className="btn" onClick={start}>Start</button>
          <Msg error={error} />
        </>
      )}

      {running && !pending && <p className="work" role="status"><span className="spin" /> Your coach is thinking…</p>}

      {pending?.kind === "read" && (
        <section className="block" ref={now as any} aria-live="polite">
          <p className="lesson-progress">{pending.times ? `Let’s try ${pending.lesson.topic} another way` : `Topic: ${pending.lesson.topic}`}</p>
          <h3>{pending.lesson.title}</h3>
          {!pending.times ? (
            <>
              <p>{pending.lesson.background}</p>
              <p><b>By the end:</b> {pending.lesson.objective}</p>
              <p>{pending.lesson.explain}</p>
              <ul>{pending.lesson.keyPoints.map((k, i) => <li key={i}>{k}</li>)}</ul>
              <p><b>Example:</b> {pending.lesson.example}</p>
              <p><b>Try it:</b> {pending.lesson.practice}</p>
              <details className="src"><summary>Show the answer</summary><p>{pending.lesson.practiceAnswer}</p></details>
              <p><b>Common mistakes:</b> {pending.lesson.commonMistakes.join(" ")}</p>
            </>
          ) : (
            <>
              <p>{pending.lesson.retry}</p>
              <ul>{pending.lesson.keyPoints.map((k, i) => <li key={i}>{k}</li>)}</ul>
              {pending.times > 1 && <p><b>Example:</b> {pending.lesson.example}</p>}
            </>
          )}
          <div className="actions">
            <button className="btn" onClick={() => release(true)}>I understand, continue</button>
            <button className="ghost" onClick={() => release(false)}>I’m still unsure</button>
          </div>
        </section>
      )}

      {pending?.kind === "quiz" && (
        <section className="block" ref={now as any}>
          <h3>{pending.round === 1 ? "Let’s see where you are" : `Test ${pending.round}: the topics you are still working on`}</h3>
          <p><small>Answer on your own. Your answers are marked by the app, not decided by the coach.</small></p>
          <Quiz qs={pending.qs} vals={vals} onPick={(i, o) => setVals((v) => v.map((x, j) => (j === i ? o : x)))} />
          <p><small>Answered {vals.filter(answered).length} of {pending.qs.length}</small></p>
          <button className="btn" disabled={vals.length !== pending.qs.length || !vals.every(answered)} onClick={() => release(vals)}>Check my answers</button>
        </section>
      )}

      {pending?.kind === "marking" && <p className="work" role="status"><span className="spin" /> Marking your answers…</p>}

      {pending?.kind === "result" && (() => {
        const { result: r } = pending;
        return (
          <section className="block" ref={now as any}>
            <h3>You got {r.right} of {r.qs.length}</h3>
            {meters(r.pct)}
            {r.qs.map((q, i) => {
              const ok = r.grades[i] ?? (q.kind === "choice" ? r.ans[i] === q.answer : q.kind === "order" && Array.isArray(r.ans[i]) && (r.ans[i] as string[]).join("|") === q.answer.join("|"));
              return (
                <section key={q.id} className={"review " + (ok ? "right" : "wrong")}>
                  <p><b>{ok ? "✓ Correct" : "✗ Not quite"}</b> — {q.text}</p>
                  {!ok && <p>Correct answer: <b>{answerText(q)}</b></p>}
                  {r.feedback[q.id] && <p>{r.feedback[q.id]}</p>}
                  <p><small>{q.why}</small></p>
                </section>
              );
            })}
            <button className="btn" onClick={() => release(undefined)}>Continue</button>
          </section>
        );
      })()}

      {(running || outcome) && (
        <section className="trace colleague-log" aria-label="What your coach is doing">
          <h3>{running ? "What your coach is doing" : outcome?.stopped ? "Stopped" : "Finished"}</h3>
          <div className="log" ref={box} aria-live="polite">
            {events.map((t) => <p key={t.id} className={"ln " + CLASS[t.kind]}><b>{LABEL[t.kind]}</b> {t.text}</p>)}
          </div>
          {running && <button className="ghost" onClick={stopNow}>Stop for now</button>}
        </section>
      )}
      {running && <Msg error={error} />}

      {outcome && !running && (
        <>
          <Msg error={error} />
          <h3>{outcome.mastered ? "✓ You proved it" : "Where you are"}</h3>
          {Object.keys(outcome.scores).length ? meters(outcome.scores) : <p>No marked test yet.</p>}
          <p className={outcome.mastered ? "note-ok" : "warn"}>{outcome.message}</p>
          <p><small>“Learned” means {TARGET}% or more on questions marked by the app. The coach’s own words never count as proof.</small></p>
          {outcome.rounds.length > 0 && <p><small>Tests taken: {outcome.rounds.map((r) => `${r.right}/${r.total}`).join(" → ")}</small></p>}
          <div className="actions">
            {outcome.course && <button className="btn" onClick={pdfFile}>Download my study summary (PDF)</button>}
            {outcome.course && <button className="btn" onClick={wordFile}>Download my study summary (Word)</button>}
            <button className="ghost" onClick={() => { setOutcome(null); setEvents([]); }}>Learn something else</button>
          </div>
          {fileNote && <p className="note-ok">{fileNote}</p>}
        </>
      )}
    </Page>
  );
}
