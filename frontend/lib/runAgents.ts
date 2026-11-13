/* The runner (browser side): runAgents(goal, state) -> a stream of events.

   This is the same loop the colleague always had, moved out of the screen so the screen only has to READ events:
     1. ask the AI (/api/colleague) which ONE tool comes next           -> the Coordinator thinks
     2. hand the job to the agent that owns that tool                    -> a "task" hand-off
     3. run the tool through the same endpoints the manual screens use   -> the agent works
     4. report back, and pass material or reviews to other agents        -> "result" and peer hand-offs
   The loop repeats until the AI finishes, a safety limit is hit, or the teacher presses Stop.

   To swap in a different runner later (for example one on a server), write a function with the type AgentRunner from
   lib/agents.ts that streams the same events. The screen does not need to change.

   To add a tool: spec in lib/colleague.ts, an owner in TOOL_OWNER (lib/agents.ts), and a runner below. */

import type { Course, Finding, Level, Question, TeacherPlan } from "./agent";
import { api, loadWork, saveWork } from "./client";
import { MAX_STEPS_HARD, type Decision, type Observation, type ResultsSummary, type Snapshot, type ToolName, type WebHit } from "./colleague";
import {
  buildLedger, handoffProblem, headline, makeHandoff, ownerOf,
  type AgentEvent, type AgentEventBody, type AgentId, type AgentRunner, type Artefact, type EmailDraft, type HandoffInput, type HandoffKind, type Handoff, type Outcome,
} from "./agents";
import { retrieve } from "./rag";
import { isLocalAddress, shareUrl } from "./share";
import { fromServer, toServer } from "../components/BlockEditor";

type Ctx = {
  course: Course | null; questions: Question[]; findings: Finding[]; checked: boolean;
  lastCheck: Snapshot["lastCheck"]; plan: TeacherPlan | null; planMinutes: number | null; notes: string; level: Level; goal: string;
  sources: WebHit[];
  canShare: boolean; passcode: string;                          // set by the teacher on the start screen
  shared: { code: string; title: string } | null;               // the test published in this run (the secret teacher key is kept on this device only, never here)
  results: ResultsSummary | null;
  emails: EmailDraft[];
};

/** What a tool may do while it runs, besides returning its result. */
type Io = {
  /** A plain note in the log (shown under the tool's owner). */
  warn: (text: string) => void;
  /** One problem the checker found. */
  finding: (text: string) => void;
  /** Pass something on to another agent. The sender is always the tool's owner. */
  pass: (to: AgentId, kind: HandoffKind, subject: string, body?: string, refs?: Artefact[]) => void;
  /** Take something from another agent. The receiver is always the tool's owner. */
  receive: (from: AgentId, kind: HandoffKind, subject: string, body?: string, refs?: Artefact[]) => void;
};
type Done = { text: string; made: string };
type Runner = (a: Decision["args"], c: Ctx, io: Io) => Promise<Done>;

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const done = (text: string, made: string): Done => ({ text, made });
const agent = <T,>(action: string, body: object) => api<T>("/api/agent", { action, ...body });

const kinds = (qs: Question[]) => {
  const n = (k: string) => qs.filter((q) => q.kind === k).length;
  return `${n("choice")} choice, ${n("explain")} written, ${n("order")} ordering`;
};

/* What the lesson, question and checker steps read: the teacher's notes, plus short web findings (if any).
   The server accepts 12,000 characters, so the notes are trimmed to leave room for the web part. */
const SOURCE_MAX = 12000;
const sourceFor = (c: Ctx) => {
  if (!c.sources.length) return c.notes;
  const web = ("Facts found on the web (short snippets, not whole pages; the teacher's notes win if they disagree):\n" +
    c.sources.slice(0, 6).map((h) => `- ${h.title} (${h.url}): ${h.snippet}`).join("\n")).slice(0, 3500);
  return `${c.notes.slice(0, SOURCE_MAX - web.length - 2)}${c.notes ? "\n\n" : ""}${web}`;
};

/* ---------------- the tools: what the agents can actually DO ----------------
   Each one returns a short sentence about what happened (the AI reads it next) and a short phrase for the "who did what" report. */
const RUNNERS: Record<Exclude<ToolName, "finish">, Runner> = {
  async search_notes(a, c, io) {
    const query = str(a.query, 120) || c.goal.slice(0, 120);
    const hits = retrieve(c.notes, query, 3);
    if (!hits.length) return done(`Nothing in the notes matched "${query}".`, "a notes search (nothing matched)");
    io.pass("writer", "material", `${plural(hits.length, "passage")} from the notes`, `Found for "${query}". Build from these, not from memory.`, [{ kind: "notes", label: query, count: hits.length }]);
    return done(`Found ${hits.length} passage${hits.length > 1 ? "s" : ""} for "${query}": ` + hits.map((h) => `"${h.text.replace(/\s+/g, " ").slice(0, 130)}…"`).join(" | "), `a notes search (${plural(hits.length, "passage")})`);
  },

  async web_search(a, c, io) {
    const query = str(a.query, 120) || c.goal.slice(0, 120);
    const { hits } = await api<{ hits: WebHit[] }>("/api/search", { query });
    if (!hits.length) return done(`The web search for "${query}" found nothing useful.`, "a web search (nothing useful)");
    const fresh = hits.filter((h) => !c.sources.some((s) => s.url === h.url));
    c.sources = [...c.sources, ...fresh].slice(0, 10);
    if (fresh.length) io.pass("writer", "material", `${plural(fresh.length, "new web source")}`, `Short snippets for "${query}". The notes win if they disagree. Listed under Sources for the teacher to check.`, [{ kind: "sources", label: query, count: fresh.length }]);
    return done(`Found ${hits.length} web result${hits.length > 1 ? "s" : ""} for "${query}" (${fresh.length} new, now in Sources): ` +
      hits.map((h) => `${h.title}: "${h.snippet.slice(0, 110)}…"`).join(" | "), `a web search (${plural(fresh.length, "new source")})`);
  },

  async build_lessons(a, c) {
    const topic = str(a.topic, 200) || c.goal.slice(0, 200);
    const outcome = str(a.outcome, 300) || c.goal.slice(0, 300);
    const { course } = await agent<{ course: Course }>("course", { goal: topic, outcome, level: c.level, source: sourceFor(c) });
    // New lessons make everything built from the old ones out of date.
    c.course = course; c.questions = []; c.findings = []; c.checked = false; c.lastCheck = null; c.plan = null; c.planMinutes = null;
    return done(`Built ${course.lessons.length} lessons: ${course.lessons.map((l) => l.topic).join(", ")}.`, plural(course.lessons.length, "lesson"));
  },

  async write_questions(_a, c, io) {
    if (!c.course) throw new Error("There are no lessons yet.");
    const d = await agent<{ questions: Question[] }>("draft", { course: c.course, level: c.level, source: sourceFor(c) });
    c.questions = d.questions; c.findings = []; c.checked = false; c.lastCheck = null;
    io.pass("checker", "review", `${plural(d.questions.length, "question")} to check`, `${kinds(d.questions)}. Not checked yet.`, [{ kind: "questions", label: "the draft test", count: d.questions.length }]);
    return done(`Wrote ${d.questions.length} questions (${kinds(d.questions)}) covering: ${Array.from(new Set(d.questions.map((q) => q.topic))).join(", ")}. Not checked yet.`, plural(d.questions.length, "question"));
  },

  async check_questions(_a, c, io) {
    if (!c.course || !c.questions.length) throw new Error("There are no questions to check.");
    const before = c.questions;
    const r = await agent<{ questions: Question[]; findings: Finding[] }>("review", { course: c.course, level: c.level, source: sourceFor(c), questions: before });
    const f = r.findings;
    const fixed = f.filter((x) => x.action === "fixed"), removed = f.filter((x) => x.action === "removed");
    c.questions = r.questions; c.findings = f; c.checked = true;
    c.lastCheck = { approved: f.filter((x) => x.action === "approved").length, fixed: fixed.length, removed: removed.length };
    for (const x of [...fixed, ...removed]) {
      const n = before.findIndex((q) => q.id === x.id) + 1;
      io.finding(`Question ${n}: ${x.problem} ${x.action === "fixed" ? "Fixed." : "Removed."}`);
    }
    const passed = !fixed.length && !removed.length;
    const problems = [...fixed, ...removed].slice(0, 3).map((x) => x.problem.slice(0, 90)).join("; ");
    if (passed) {
      // Only the publisher cares: it may not share without a clean pass.
      if (c.canShare) io.pass("publisher", "approved", `All ${r.questions.length} questions passed with no changes`, "This test may be shared.", [{ kind: "test", label: "the checked test", count: r.questions.length }]);
    } else {
      io.pass("writer", "rework", `${fixed.length} fixed, ${removed.length} removed`, `${problems || "Unclear problems."} The test must be checked again before it can be shared.`, [{ kind: "questions", label: "the test after the check", count: r.questions.length }]);
    }
    return passed
      ? done(`PASSED: all ${r.questions.length} questions approved with no changes.`, `a clean pass on ${plural(r.questions.length, "question")}`)
      : done(`NOT a clean pass: ${c.lastCheck.approved} approved, ${fixed.length} fixed, ${removed.length} removed (${r.questions.length} left). Problems: ${problems || "unclear"}.`,
        `a check: ${c.lastCheck.approved} approved, ${fixed.length} fixed, ${removed.length} removed`);
  },

  async plan_lesson(a, c) {
    if (!c.course) throw new Error("There are no lessons yet.");
    const minutes = Math.min(180, Math.max(20, Math.round(Number(a.minutes) || 50)));
    const { plan } = await agent<{ plan: TeacherPlan }>("teacherPlan", {
      course: c.course, goal: c.goal.slice(0, 200), outcome: c.goal.slice(0, 300), level: c.level, source: sourceFor(c), durationMinutes: minutes,
    });
    c.plan = plan; c.planMinutes = plan.durationMinutes;
    return done(`Made a ${plan.durationMinutes}-minute lesson plan with ${plan.steps.length} timed steps.`, `a ${plan.durationMinutes}-minute lesson plan`);
  },

  /* Publishes the test exactly the way the "Tests and classwork" screen does, and saves the teacher key on this device
     so it appears under "My tests". The key is a secret: it is never put in the log, the report, a hand-off or the AI's notes. */
  async share_test(_a, c) {
    if (!c.canShare) throw new Error("Sharing was not switched on for this run.");
    if (c.shared) throw new Error(`The test is already shared (code ${c.shared.code}).`);
    if (!c.questions.length) throw new Error("There are no questions to share.");
    if (!c.checked) throw new Error("The test has not been through the checker.");
    const title = (c.course?.title || "Test from my colleague").slice(0, 120);
    const r = await api<{ code: string; editKey: string }>("/api/work", {
      action: "create", passcode: c.passcode, title, kind: "test", instructions: "", showAnswers: true,
      questions: c.questions.map((q) => toServer(fromServer(q))),
    });
    saveWork([{ code: r.code, key: r.editKey, title, kind: "test" }, ...loadWork().filter((w) => w.code !== r.code)]);
    c.shared = { code: r.code, title };
    return done(`Shared "${title}" with ${c.questions.length} questions. Learners can open it with the code ${r.code}. It has no answers yet.`, `the test shared with code ${r.code}`);
  },

  /* Reads results for a test this teacher shared from this device. Only totals go back to the AI. */
  async read_results(a, c) {
    const saved = loadWork();
    if (!saved.length) throw new Error("No test has been shared from this device yet.");
    const asked = str(a.test, 120);
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
    let w = saved[0];
    if (asked) {
      const found = saved.find((x) => norm(x.code) === norm(asked) || x.title.toLowerCase().includes(asked.toLowerCase()));
      if (!found) throw new Error(`No shared test matches "${asked.slice(0, 60)}". The tests on this device are: ${saved.slice(0, 5).map((x) => x.title).join("; ")}.`);
      w = found;
    } else if (c.shared) {
      w = saved.find((x) => x.code === c.shared?.code) || w;
    }
    const r = await api<{
      title: string; count: number; average: number; weakTopics: string[]; questions: { text: string; pct: number }[];
    }>("/api/work", { action: "results", code: w.code, editKey: w.key });
    c.results = { title: r.title, count: r.count, average: r.average, weak: r.weakTopics };
    if (!r.count) return done(`Nobody has handed in "${r.title}" yet (code ${w.code}).`, `a results check (nobody has handed in yet)`);
    const hardest = [...r.questions].sort((x, y) => x.pct - y.pct).slice(0, 2).map((q) => `"${q.text.slice(0, 60)}" (${q.pct}% right)`).join("; ");
    return done(`"${r.title}": ${r.count} handed in, class average ${r.average}%. ` +
      (r.weakTopics.length ? `Topics under 70%: ${r.weakTopics.join(", ")}. ` : "No topic is under 70%. ") + `Hardest questions: ${hardest}. (Learner names and written answers stay on the results screen.)`,
      `the results of "${r.title}" (${r.count} handed in, average ${r.average}%)`);
  },

  /* A DRAFT only. Nothing is sent. The share link and code are added here in code, so the AI can never get them wrong. */
  async draft_email(a, c, io) {
    const to = a.to === "parents" || a.to === "colleagues" ? a.to : "learners";
    const about = str(a.about, 200) || "an update on the lesson";
    // The Messenger gets what it needs from the others through hand-offs, then writes.
    if (c.course) io.receive("writer", "material", "What was prepared", `${plural(c.course.lessons.length, "lesson")}${c.questions.length ? ` and a ${c.questions.length}-question test` : ""}.`, [{ kind: "lessons", label: c.course.title.slice(0, 60), count: c.course.lessons.length }]);
    if (c.shared) io.receive("publisher", "material", "Share link and code", `The test is shared with the code ${c.shared.code}. The app adds the link and code to the email itself.`, [{ kind: "test", label: "the shared test" }]);
    if (c.results) io.receive("publisher", "material", "Class results (totals only)", c.results.count ? `${plural(c.results.count, "learner")} handed in, class average ${c.results.average}%.` : "Nobody has handed in yet.", [{ kind: "results", label: c.results.title.slice(0, 60), count: c.results.count }]);
    const facts = [
      c.course ? `Lesson set: ${c.course.title}. Topics: ${c.course.lessons.map((l) => l.topic).join(", ")}.` : "",
      c.questions.length ? `A test of ${c.questions.length} questions was prepared${c.shared ? " and is shared with a link and code (added below by the app)" : ""}.` : "",
      c.results ? (c.results.count ? `Results so far: ${c.results.count} learners handed in "${c.results.title}", class average ${c.results.average}%${c.results.weak.length ? `, topics to revisit: ${c.results.weak.join(", ")}` : ""}.` : `Nobody has handed in "${c.results.title}" yet.`) : "",
      `Reader: ${to}. Goal of the whole job: ${c.goal.slice(0, 200)}`,
    ].filter(Boolean).join("\n");
    const { text } = await api<{ text: string }>("/api/assist", { action: "email", role: "teacher", instruction: `Email to ${to}: ${about}`, text: facts, context: "" });
    const m = text.match(/^\s*Subject:\s*(.+)\n+([\s\S]*)$/i);
    const subject = (m ? m[1] : `Message for ${to}`).trim().slice(0, 100);
    let body = (m ? m[2] : text).trim();
    if (c.shared) {
      body += `\n\nOpen the test here: ${shareUrl(c.shared.code)}\nOr type the code ${c.shared.code} on the ProofLearn home page. No account is needed.`;
      if (isLocalAddress()) io.warn("The link in this email only opens on this computer. Put ProofLearn online and set NEXT_PUBLIC_APP_URL before you send it to anyone (see README).");
    }
    c.emails = [...c.emails, { to, subject, body }].slice(-3);
    return done(`Wrote a draft email to ${to} (subject: "${subject}"). It is only a draft: nothing was sent.`, `an email draft to ${to}`);
  },
};

const describe = (d: Decision) => {
  const a = d.args;
  switch (d.action) {
    case "web_search": return `Searching the web for “${str(a.query, 120) || "the goal"}”…`;
    case "search_notes": return `Searching your notes for “${str(a.query, 120) || "the goal"}”…`;
    case "build_lessons": return "Writing the lessons…";
    case "write_questions": return "Writing the test questions…";
    case "check_questions": return "The checker is going through every question…";
    case "share_test": return "Sharing the checked test with learners…";
    case "read_results": return `Reading the class results${str(a.test, 120) ? ` for “${str(a.test, 120)}”` : ""}…`;
    case "draft_email": return `Drafting an email to ${a.to === "parents" || a.to === "colleagues" ? a.to : "learners"}…`;
    case "plan_lesson": return `Writing a ${Math.round(Number(a.minutes) || 50)}-minute lesson plan…`;
    default: return "Finishing…";
  }
};

/** What the Coordinator tells the owner of a tool, as a hand-off subject. */
const taskSubject = (d: Decision) => describe(d).replace(/…$/, "");

const snapshot = (c: Ctx, uses: Snapshot["uses"], failures: number): Snapshot => ({
  noteChars: c.notes.trim().length,
  lessons: c.course?.lessons.map((l) => l.topic) || [],
  questions: c.questions.length, checked: c.checked, lastCheck: c.lastCheck, planMinutes: c.planMinutes, failures, uses,
  webSearch: true,            // placeholder: the server checks for itself whether web search is set up
  sources: c.sources.length,
  canShare: c.canShare, shareCode: c.shared?.code || null,
  savedTests: loadWork().slice(0, 10).map((w) => w.title),
  results: c.results,
});

export const wrapUp = (c: Pick<Ctx, "course" | "questions" | "checked" | "plan" | "sources" | "shared" | "results" | "emails">) => {
  const bits: string[] = [];
  if (c.course) bits.push(`${c.course.lessons.length} lessons`);
  if (c.questions.length) bits.push(`a ${c.questions.length}-question test${c.checked ? " (checked)" : " (NOT approved by the checker)"}`);
  if (c.plan) bits.push(`a ${c.plan.durationMinutes}-minute lesson plan`);
  if (c.sources.length) bits.push(`${c.sources.length} web sources (listed in the report, please check them)`);
  if (c.shared) bits.push(`the test shared with the code ${c.shared.code}`);
  if (c.results) bits.push(`the results of "${c.results.title}" (${c.results.count} handed in)`);
  if (c.emails.length) bits.push(`${c.emails.length} email draft${c.emails.length > 1 ? "s" : ""} (not sent)`);
  return bits.length ? `I made ${bits.join(", ")}. Please read everything before you use it with learners.` : "I could not make anything for this goal. Try describing it a little differently.";
};

/* ---------------- the runner ---------------- */
export const runAgents: AgentRunner = async function* (goal, state) {
  const c: Ctx = {
    course: null, questions: [], findings: [], checked: false, lastCheck: null, plan: null, planMinutes: null,
    notes: state.notes.trim(), level: state.level, goal, sources: [],
    canShare: state.canShare, passcode: state.passcode, shared: null, results: null, emails: [],
  };
  const maxSteps = Math.max(1, Math.min(MAX_STEPS_HARD, Math.round(state.maxSteps) || 1));
  const log: AgentEvent[] = [];            // everything emitted, kept to build the ledger at the end
  const queue: AgentEvent[] = [];          // events made by a tool while it was running, handed out after it finishes
  const handoffs: Handoff[] = [];
  let seq = 0, hid = 0, step = 0;
  const stamp = (e: AgentEventBody): AgentEvent => { const ev = { ...e, seq: ++seq, at: Date.now() } as AgentEvent; log.push(ev); return ev; };
  const later = (e: AgentEventBody) => { queue.push(stamp(e)); };
  const note = (agent: AgentId, level: "info" | "warn", text: string, tag?: "overruled" | "stopped") => later({ type: "note", agent, level, text, ...(tag ? { tag } : {}) });
  const send = (i: HandoffInput) => {
    const h = makeHandoff(`h${++hid}`, i);
    const bad = handoffProblem(h);
    if (bad) { note("coordinator", "warn", `A hand-off was dropped (${bad}).`); return; }   // a protocol slip must never crash a run
    handoffs.push(h);
    later({ type: "handoff", handoff: h });
  };
  const drain = function* (): Generator<AgentEvent> { while (queue.length) yield queue.shift() as AgentEvent; };

  const uses: Snapshot["uses"] = {};
  const seen: Observation[] = [];
  let failures = 0, plan: string[] = [], summary = "", stopped = false, steps = 0, runError = "";
  const stopNow = () => !!state.shouldStop?.();

  yield stamp({ type: "goal", text: goal });
  yield stamp({ type: "note", agent: "coordinator", level: "info", text: c.notes ? `I have your notes (${c.notes.length.toLocaleString()} characters). I will decide for myself what to do and in what order.` : "No notes were given, so I will teach from general knowledge. I will decide for myself what to do and in what order." });

  try {
    for (step = 1; step <= maxSteps + 1; step++) {
      if (stopNow()) { stopped = true; yield stamp({ type: "note", agent: "coordinator", level: "warn", text: "Stopped. Here is what I have so far.", tag: "stopped" }); break; }
      const { decision: d } = await api<{ decision: Decision }>("/api/colleague", {
        goal, level: state.level, maxSteps, step, snapshot: snapshot(c, uses, failures), observations: seen.slice(-8), plan,
      });
      if (stopNow()) { stopped = true; yield stamp({ type: "note", agent: "coordinator", level: "warn", text: "Stopped. Here is what I have so far.", tag: "stopped" }); break; }
      if (d.plan.length) { plan = d.plan; yield stamp({ type: "plan", steps: d.plan }); }
      if (d.fallback) yield stamp({ type: "note", agent: "coordinator", level: "warn", text: d.fallback, tag: "overruled" });
      yield stamp({ type: "think", agent: "coordinator", step, text: d.thought });
      if (d.action === "finish") {
        summary = str(d.args.summary, 900) || wrapUp(c);
        yield stamp({ type: "done", agent: "coordinator", step, text: summary });
        break;
      }

      steps++;
      uses[d.action] = (uses[d.action] || 0) + 1;
      const owner = ownerOf(d.action);
      send({ step, from: "coordinator", to: owner, kind: "task", subject: taskSubject(d), refs: [] });
      yield* drain();
      yield stamp({ type: "act", agent: owner, step, tool: d.action, text: describe(d) });

      const io: Io = {
        warn: (text) => note(owner, "warn", text),
        finding: (text) => later({ type: "finding", agent: owner, text }),
        pass: (to, kind, subject, body, refs) => send({ step, from: owner, to, kind, subject, body, refs }),
        receive: (from, kind, subject, body, refs) => send({ step, from, to: owner, kind, subject, body, refs }),
      };
      let r: Done | null = null, msg = "";
      try { r = await RUNNERS[d.action](d.args, c, io); } catch (e: any) { msg = String(e?.message || "That step failed.").slice(0, 200); }
      yield* drain();            // whatever the tool said or passed on while it worked comes BEFORE its result, so the stream stays in order
      if (r) {
        failures = 0;
        seen.push({ step, action: d.action, ok: true, text: r.text });
        yield stamp({ type: "result", agent: owner, step, tool: d.action, ok: true, text: r.text, made: r.made });
        send({ step, from: owner, to: "coordinator", kind: "result", subject: r.made, body: r.text, refs: [] });
      } else {
        failures++;
        seen.push({ step, action: d.action, ok: false, text: msg });
        yield stamp({ type: "result", agent: owner, step, tool: d.action, ok: false, text: `That step did not work: ${msg}`, made: "" });
        send({ step, from: owner, to: "coordinator", kind: "result", subject: "That step did not work", body: msg, refs: [], ok: false });
        // A rest or a rejected key will not fix itself by trying a different tool.
        if (failures >= 3) { note("coordinator", "warn", "Three steps in a row failed, so I am stopping here."); yield* drain(); break; }
      }
      yield* drain();
    }
  } catch (e: any) {
    runError = e?.message || "Something went wrong. Please try again.";
  }
  yield* drain();
  if (runError) yield stamp({ type: "error", text: runError });

  const ledger = buildLedger(log);
  const outcome: Outcome = {
    course: c.course, questions: c.questions, plan: c.plan, approved: c.checked && c.questions.length > 0,
    summary: summary || wrapUp(c), stopped, steps, sources: c.sources, shared: c.shared, results: c.results, emails: c.emails,
    ledger, handoffs, headline: headline(ledger, handoffs),
  };
  yield stamp({ type: "end", outcome });
};
