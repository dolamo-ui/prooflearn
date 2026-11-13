/* The multi-agent layer (Phase A). Pure TypeScript: no React, no fetch, no browser. Everything here can be tested with plain node.

   WHAT THIS FILE IS
     1. The agent REGISTRY: who the agents are, what each one does, which tools each one owns.
     2. The HAND-OFF format: the one message shape agents use to pass work to each other, with rules for who may send what to whom.
     3. The EVENT stream: what a run produces, in order. The screen only ever reads these events.
     4. The LEDGER: the "who did what" report, built from the events and nothing else.

   THE ONE INTERFACE (see lib/runAgents.ts)
     runAgents(goal, state) -> a stream of AgentEvent
   Today that stream comes from the browser loop. Later (Phase B) it can come from a server runner that uses the SAME events,
   and the screen, the lanes and the report will not change.

   HONEST NOTE ON WHAT "AGENT" MEANS RIGHT NOW
   The coordinator is the only one that decides what happens next. The other agents are specialists that each own a set of
   tools and may not touch anyone else's. Hand-offs record what was passed on and why. Real separate reasoning per agent comes later. */

import type { Course, Level, Question, TeacherPlan } from "./agent";
import type { ResultsSummary, ToolName, WebHit } from "./colleague";

/* ---------------- 1. the registry ---------------- */

export type AgentId = "coordinator" | "researcher" | "writer" | "checker" | "publisher" | "messenger";

export type AgentSpec = {
  id: AgentId;
  name: string;          // shown to the teacher
  job: string;           // one plain sentence
  limit: string;         // what this agent is NOT allowed to do (shown in the guide, enforced by the tool owner table below)
};

/** Order matters: it is the order of the lanes and of the report. The coordinator is always first. */
export const AGENTS: AgentSpec[] = [
  { id: "coordinator", name: "Coordinator", job: "Reads the goal, makes the plan and decides who does the next piece of work. Writes the final report.", limit: "Owns no tools. It cannot make lessons, tests or emails itself." },
  { id: "researcher", name: "Researcher", job: "Looks through the teacher's notes and, when it is set up, the web.", limit: "Only reads. It builds nothing and publishes nothing." },
  { id: "writer", name: "Writer", job: "Builds the lessons, writes the test questions and writes the lesson plan.", limit: "Cannot share a test or write an email." },
  { id: "checker", name: "Checker", job: "Goes through every question: is it supported by the lessons, clear, and is the answer right? Fixes or removes bad ones.", limit: "Cannot write new questions and cannot share anything." },
  { id: "publisher", name: "Publisher", job: "Shares a checked test with learners and reads back the class results (totals only).", limit: "Only when the teacher allowed sharing, and only for a test that passed the checker with no changes." },
  { id: "messenger", name: "Messenger", job: "Writes email drafts for learners, parents or colleagues.", limit: "Drafts only. It never sends anything." },
];

export const agentById = (id: AgentId): AgentSpec => AGENTS.find((a) => a.id === id) || AGENTS[0];
export const isAgentId = (v: unknown): v is AgentId => AGENTS.some((a) => a.id === v);

/** Which agent owns which tool. Each tool has exactly one owner. The Record type makes it a compile error to add a tool and forget its owner.
    "finish" is not here on purpose: finishing belongs to the coordinator. */
export const TOOL_OWNER: Record<Exclude<ToolName, "finish">, AgentId> = {
  search_notes: "researcher",
  web_search: "researcher",
  build_lessons: "writer",
  write_questions: "writer",
  plan_lesson: "writer",
  check_questions: "checker",
  share_test: "publisher",
  read_results: "publisher",
  draft_email: "messenger",
};

export const ownerOf = (tool: ToolName): AgentId => (tool === "finish" ? "coordinator" : TOOL_OWNER[tool]);
export const toolsOf = (id: AgentId): ToolName[] =>
  (Object.keys(TOOL_OWNER) as Exclude<ToolName, "finish">[]).filter((t) => TOOL_OWNER[t] === id);

/* ---------------- 2. the hand-off message ---------------- */

/** What a hand-off is for.
    task      coordinator -> agent      "please do this"
    result    agent -> coordinator      "here is what happened"
    material  agent -> agent            "this is what I found or made, use it"
    review    agent -> agent            "please check this"
    rework    agent -> agent            "this came back with problems, please redo it"
    approved  agent -> agent            "this passed, you may go ahead" */
export type HandoffKind = "task" | "result" | "material" | "review" | "rework" | "approved";
export const HANDOFF_KINDS: HandoffKind[] = ["task", "result", "material", "review", "rework", "approved"];

/** A pointer to something in the run's shared work. A hand-off never carries the work itself, and never carries secrets. */
export type ArtefactKind = "notes" | "sources" | "lessons" | "questions" | "plan" | "test" | "results" | "email";
export type Artefact = { kind: ArtefactKind; label: string; count?: number };

export type Handoff = {
  v: 1;                  // format version, so a later runner can tell which shape it is reading
  id: string;            // h1, h2, ... within one run
  step: number;          // the coordinator step it belongs to (0 = before the first step)
  from: AgentId;
  to: AgentId;
  kind: HandoffKind;
  subject: string;       // max 90 characters
  body: string;          // max 400 characters, plain text
  refs: Artefact[];      // max 4
  ok: boolean;           // false = the work behind it failed
};

export const SUBJECT_MAX = 90;
export const BODY_MAX = 400;
const flat = (s: unknown, n: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, n) : "");

/** The routing rules. Returns what is wrong, or null when the hand-off is allowed. */
export function handoffProblem(h: Partial<Handoff> | null | undefined): string | null {
  if (!h || typeof h !== "object") return "not a hand-off";
  if (h.v !== 1) return "unknown format version";
  if (!isAgentId(h.from) || !isAgentId(h.to)) return "unknown agent";
  if (h.from === h.to) return "an agent cannot hand work to itself";
  if (!HANDOFF_KINDS.includes(h.kind as HandoffKind)) return "unknown kind";
  if (!flat(h.subject, SUBJECT_MAX)) return "missing subject";
  const fromBoss = h.from === "coordinator", toBoss = h.to === "coordinator";
  if (h.kind === "task" && !fromBoss) return "only the coordinator gives tasks";
  if (h.kind === "result" && !toBoss) return "results go to the coordinator";
  if (h.kind !== "task" && h.kind !== "result" && (fromBoss || toBoss)) return `${h.kind} is for hand-offs between specialists`;
  return null;
}

export type HandoffInput = {
  step: number; from: AgentId; to: AgentId; kind: HandoffKind;
  subject: string; body?: string; refs?: Artefact[]; ok?: boolean;
};

/** Builds a hand-off with every text clamped to its limit. It does not check the routing rules: use handoffProblem for that. */
export function makeHandoff(id: string, i: HandoffInput): Handoff {
  return {
    v: 1, id, step: Math.max(0, Math.round(i.step) || 0), from: i.from, to: i.to, kind: i.kind,
    subject: flat(i.subject, SUBJECT_MAX), body: flat(i.body, BODY_MAX),
    refs: (i.refs || []).slice(0, 4).map((r) => ({ kind: r.kind, label: flat(r.label, 60), ...(typeof r.count === "number" ? { count: r.count } : {}) })),
    ok: i.ok !== false,
  };
}

/* ---------------- 3. the event stream ---------------- */

/** The finished run, as the report needs it. */
export type EmailDraft = { to: string; subject: string; body: string };
export type Outcome = {
  course: Course | null; questions: Question[]; plan: TeacherPlan | null; approved: boolean;
  summary: string; stopped: boolean; steps: number; sources: WebHit[];
  shared: { code: string; title: string } | null; results: ResultsSummary | null; emails: EmailDraft[];
  ledger: LedgerRow[];       // who did what
  handoffs: Handoff[];       // every hand-off, in order
  headline: string;          // one sentence over the whole ledger
};

type Stamp = { seq: number; at: number };   // seq: 1, 2, 3 ... in order; at: milliseconds since 1970

export type AgentEventBody =
  | { type: "goal"; text: string }
  | { type: "plan"; steps: string[] }
  | { type: "think"; agent: "coordinator"; step: number; text: string }
  | { type: "act"; agent: AgentId; step: number; tool: ToolName; text: string }
  | { type: "result"; agent: AgentId; step: number; tool: ToolName; ok: boolean; text: string; made: string }
  | { type: "finding"; agent: AgentId; text: string }                       // one problem the checker found
  | { type: "handoff"; handoff: Handoff }
  | { type: "note"; agent: AgentId; level: "info" | "warn"; text: string; tag?: "overruled" | "stopped" }
  | { type: "done"; agent: "coordinator"; step: number; text: string }
  | { type: "error"; text: string }                                         // the run itself broke (not just one tool)
  | { type: "end"; outcome: Outcome };                                      // always the last event

export type AgentEvent = AgentEventBody & Stamp;

/** What goes into a run. Everything the runner needs, nothing it should reach for by itself. */
export type RunState = {
  notes: string;
  level: Level;
  maxSteps: number;
  canShare: boolean;
  passcode: string;
  shouldStop?: () => boolean;     // asked before every step; true = wrap up now
};

/** THE interface. A runner takes the goal and the settings and streams events, ending with one "end" event. */
export type AgentRunner = (goal: string, state: RunState) => AsyncGenerator<AgentEvent, void, void>;

/* ---------------- 4. the ledger: "who did what" ---------------- */

export type LedgerRow = {
  agent: AgentId;
  name: string;
  steps: number;                                 // coordinator: decisions made. Others: jobs taken
  ok: number;
  failed: number;
  tools: Partial<Record<ToolName, number>>;
  made: string[];                                // short plain phrases, in order: "5 lessons", "6 questions", ...
  sent: number;                                  // hand-offs sent
  received: number;                              // hand-offs received
  ms: number;                                    // time spent on its jobs
  notes: string[];                               // things worth knowing (an overruled pick, a rework request)
};

const blank = (id: AgentId): LedgerRow => ({ agent: id, name: agentById(id).name, steps: 0, ok: 0, failed: 0, tools: {}, made: [], sent: 0, received: 0, ms: 0, notes: [] });

/** Builds the "who did what" rows from the events alone. Only agents that took part are listed. */
export function buildLedger(events: AgentEvent[]): LedgerRow[] {
  const rows = new Map<AgentId, LedgerRow>(AGENTS.map((a) => [a.id, blank(a.id)]));
  const row = (id: AgentId) => rows.get(id) as LedgerRow;
  const started = new Map<number, number>();    // step -> time the job began
  let overruled = 0;
  for (const e of events) {
    switch (e.type) {
      case "think": row("coordinator").steps++; break;
      case "plan": row("coordinator").made.push(`a plan of ${e.steps.length} step${e.steps.length === 1 ? "" : "s"}`); break;
      case "done": row("coordinator").made.push("the final report"); break;
      case "act": {
        const r = row(e.agent);
        r.steps++; r.tools[e.tool] = (r.tools[e.tool] || 0) + 1;
        started.set(e.step, e.at);
        break;
      }
      case "result": {
        const r = row(e.agent);
        if (e.ok) { r.ok++; if (e.made) r.made.push(e.made); } else { r.failed++; r.notes.push(`a step failed: ${e.text.slice(0, 80)}`); }
        const t0 = started.get(e.step);
        if (t0 !== undefined) r.ms += Math.max(0, e.at - t0);
        break;
      }
      case "note":
        if (e.tag === "overruled") overruled++;
        break;
      case "handoff": {
        const h = e.handoff;
        row(h.from).sent++; row(h.to).received++;
        if (h.kind === "rework") row(h.from).notes.push(`sent work back to the ${agentById(h.to).name}: ${h.subject}`);
        break;
      }
    }
  }
  if (overruled) row("coordinator").notes.push(`the safety rules overruled its pick ${overruled} time${overruled === 1 ? "" : "s"}`);
  return AGENTS.map((a) => row(a.id)).filter((r) => r.steps || r.sent || r.received);
}

/** One plain sentence over the whole ledger. */
export function headline(rows: LedgerRow[], handoffs: Handoff[]): string {
  const specialists = rows.filter((r) => r.agent !== "coordinator").length;
  if (!specialists) return "No specialist did any work in this run.";
  const peer = handoffs.filter((h) => h.kind !== "task" && h.kind !== "result");
  const back = peer.filter((h) => h.kind === "rework").length;
  return `${specialists} specialist${specialists === 1 ? "" : "s"} worked under the Coordinator, with ${handoffs.length} hand-off${handoffs.length === 1 ? "" : "s"} (${peer.length} directly between specialists).` +
    (back ? ` The Checker sent work back ${back} time${back === 1 ? "" : "s"}.` : "");
}

const count = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** One plain line per agent for the report, on screen and in the PDF and Word file.
    "Writer: 5 lessons; 6 questions. 3 jobs, 2 hand-offs sent, 5 received, took about 12 s." */
export function ledgerLine(r: LedgerRow): string {
  const did = r.agent === "coordinator"
    ? [`made ${count(r.steps, "decision")}`, ...r.made]
    : r.made.length ? r.made : ["did not finish any job"];
  const facts = [
    r.agent === "coordinator" ? "" : count(r.steps, "job"),
    r.failed ? `${r.failed} failed` : "",
    r.sent ? `${count(r.sent, "hand-off")} sent` : "",
    r.received ? `${r.received} received` : "",
    r.ms >= 950 ? `took about ${seconds(r.ms)}` : "",
  ].filter(Boolean).join(", ");
  return `${r.name}: ${did.join("; ")}.${facts ? ` ${facts[0].toUpperCase()}${facts.slice(1)}.` : ""}`;
}

export const seconds = (ms: number) => (ms < 950 ? "under a second" : `${Math.round(ms / 1000)} s`);

/** "Writer → Checker (review): 6 questions are ready to check" */
export const handoffLine = (h: Handoff) => `${agentById(h.from).name} → ${agentById(h.to).name} (${h.kind}): ${h.subject}`;
