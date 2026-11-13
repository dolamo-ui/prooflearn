// Pure-logic test of the multi-agent layer (lib/agents.ts): registry, hand-off rules, ledger. No server, no browser, no AI.
// Run: node --experimental-strip-types tests/agents.mjs      (Node 22.6 or newer)
import { AGENTS, TOOL_OWNER, ownerOf, toolsOf, handoffProblem, makeHandoff, buildLedger, headline, ledgerLine, handoffLine, agentById } from "../lib/agents.ts";
import { TOOLS } from "../lib/colleague.ts";

const fails = [];
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (!ok && extra ? " — " + extra : "")); if (!ok) fails.push(name); };

// ---------- registry ----------
check("registry: agent ids are unique and the coordinator is first", new Set(AGENTS.map((a) => a.id)).size === AGENTS.length && AGENTS[0].id === "coordinator");
check("registry: every tool except finish has exactly one owner", TOOLS.filter((t) => t.name !== "finish").every((t) => TOOL_OWNER[t.name] && AGENTS.some((a) => a.id === TOOL_OWNER[t.name])), "a tool has no owner: add it to TOOL_OWNER");
check("registry: no owner is listed for a tool that does not exist", Object.keys(TOOL_OWNER).every((n) => TOOLS.some((t) => t.name === n)));
check("registry: finish belongs to the coordinator", ownerOf("finish") === "coordinator");
check("registry: toolsOf covers every owned tool once", AGENTS.flatMap((a) => toolsOf(a.id)).sort().join() === Object.keys(TOOL_OWNER).sort().join());
check("registry: the coordinator owns no tools", toolsOf("coordinator").length === 0);
check("registry: the checker owns only check_questions, the messenger only draft_email", toolsOf("checker").join() === "check_questions" && toolsOf("messenger").join() === "draft_email");
check("registry: every agent has a job and a limit written down", AGENTS.every((a) => a.job.length > 10 && a.limit.length > 10));

// ---------- hand-off format and routing rules ----------
const mk = (o) => makeHandoff("h1", { step: 1, subject: "x", ...o });
check("handoff: coordinator task to an agent is allowed", handoffProblem(mk({ from: "coordinator", to: "writer", kind: "task" })) === null);
check("handoff: agent result to the coordinator is allowed", handoffProblem(mk({ from: "writer", to: "coordinator", kind: "result" })) === null);
check("handoff: review from writer to checker is allowed", handoffProblem(mk({ from: "writer", to: "checker", kind: "review" })) === null);
check("handoff: rework from checker to writer is allowed", handoffProblem(mk({ from: "checker", to: "writer", kind: "rework" })) === null);
check("handoff: approved from checker to publisher is allowed", handoffProblem(mk({ from: "checker", to: "publisher", kind: "approved" })) === null);
check("handoff: only the coordinator may give tasks", handoffProblem(mk({ from: "writer", to: "checker", kind: "task" })) !== null);
check("handoff: results must go to the coordinator", handoffProblem(mk({ from: "writer", to: "checker", kind: "result" })) !== null);
check("handoff: a review cannot involve the coordinator", handoffProblem(mk({ from: "coordinator", to: "checker", kind: "review" })) !== null && handoffProblem(mk({ from: "writer", to: "coordinator", kind: "material" })) !== null);
check("handoff: an agent cannot hand work to itself", handoffProblem(mk({ from: "writer", to: "writer", kind: "material" })) !== null);
check("handoff: unknown agent, unknown kind and empty subject are refused",
  handoffProblem({ ...mk({ from: "writer", to: "checker", kind: "review" }), to: "wizard" }) !== null &&
  handoffProblem({ ...mk({ from: "writer", to: "checker", kind: "review" }), kind: "gossip" }) !== null &&
  handoffProblem(mk({ from: "writer", to: "checker", kind: "review", subject: "   " })) !== null);
check("handoff: garbage is refused, not a crash", handoffProblem(null) !== null && handoffProblem("hi") !== null && handoffProblem({}) !== null);
check("handoff: wrong format version is refused", handoffProblem({ ...mk({ from: "writer", to: "checker", kind: "review" }), v: 2 }) !== null);

const long = makeHandoff("h9", { step: 3, from: "researcher", to: "writer", kind: "material", subject: "s".repeat(500), body: "b".repeat(5000),
  refs: Array.from({ length: 9 }, (_, i) => ({ kind: "notes", label: "l".repeat(200), count: i })), editKey: "SECRET-TEACHER-KEY", passcode: "letmein" });
check("handoff: long text and too many refs are cut to the limits", long.subject.length <= 90 && long.body.length <= 400 && long.refs.length <= 4 && long.refs.every((r) => r.label.length <= 60));
check("handoff: extra fields (such as a secret key) never get into a hand-off", !JSON.stringify(long).includes("SECRET-TEACHER-KEY") && !JSON.stringify(long).includes("letmein") && !("editKey" in long));
check("handoff: line breaks are flattened to plain text", !/\n/.test(makeHandoff("h2", { step: 1, from: "writer", to: "checker", kind: "review", subject: "a\nb", body: "c\n\nd" }).body));

// ---------- ledger ----------
let seq = 0, t = 1_000_000;
const ev = (e, dt = 100) => ({ ...e, seq: ++seq, at: (t += dt) });
const hand = (id, from, to, kind, subject) => ev({ type: "handoff", handoff: makeHandoff(id, { step: 1, from, to, kind, subject }) }, 0);
const events = [
  ev({ type: "goal", text: "g" }),
  ev({ type: "plan", steps: ["a", "b", "c"] }),
  ev({ type: "think", agent: "coordinator", step: 1, text: "t" }),
  hand("h1", "coordinator", "researcher", "task", "Searching your notes"),
  ev({ type: "act", agent: "researcher", step: 1, tool: "search_notes", text: "…" }),
  ev({ type: "result", agent: "researcher", step: 1, tool: "search_notes", ok: true, text: "found", made: "a notes search (2 passages)" }, 2000),
  hand("h2", "researcher", "writer", "material", "2 passages from the notes"),
  hand("h3", "researcher", "coordinator", "result", "a notes search"),
  ev({ type: "think", agent: "coordinator", step: 2, text: "t" }),
  ev({ type: "act", agent: "writer", step: 2, tool: "write_questions", text: "…" }),
  ev({ type: "result", agent: "writer", step: 2, tool: "write_questions", ok: true, text: "wrote", made: "6 questions" }, 3000),
  hand("h4", "writer", "checker", "review", "6 questions to check"),
  ev({ type: "act", agent: "checker", step: 3, tool: "check_questions", text: "…" }),
  ev({ type: "result", agent: "checker", step: 3, tool: "check_questions", ok: true, text: "not clean", made: "a check: 4 approved, 2 fixed, 0 removed" }, 1500),
  hand("h5", "checker", "writer", "rework", "2 fixed, 0 removed"),
  ev({ type: "act", agent: "writer", step: 4, tool: "plan_lesson", text: "…" }),
  ev({ type: "result", agent: "writer", step: 4, tool: "plan_lesson", ok: false, text: "That step did not work: boom", made: "" }, 500),
  ev({ type: "note", agent: "coordinator", level: "warn", text: "safe default", tag: "overruled" }),
  ev({ type: "done", agent: "coordinator", step: 5, text: "all done" }),
];
const rows = buildLedger(events);
const by = (id) => rows.find((r) => r.agent === id);
check("ledger: only agents that took part are listed, in registry order", rows.map((r) => r.agent).join() === "coordinator,researcher,writer,checker", rows.map((r) => r.agent).join());
check("ledger: the publisher and messenger did nothing, so they are not listed", !by("publisher") && !by("messenger"));
check("ledger: the coordinator's decisions, plan and report are counted", by("coordinator").steps === 2 && by("coordinator").made.includes("a plan of 3 steps") && by("coordinator").made.includes("the final report"));
check("ledger: jobs, ok and failed are counted per agent", by("writer").steps === 2 && by("writer").ok === 1 && by("writer").failed === 1 && by("researcher").ok === 1);
check("ledger: what each agent made is listed in order", by("writer").made.join() === "6 questions" && by("checker").made[0].startsWith("a check"));
check("ledger: time spent is the gap between a job's start and its result", by("researcher").ms === 2000 && by("writer").ms === 3500 && by("checker").ms === 1500, [by("researcher").ms, by("writer").ms, by("checker").ms].join());
check("ledger: hand-offs sent and received are counted", by("researcher").sent === 2 && by("writer").received === 2 && by("coordinator").sent === 1 && by("coordinator").received === 1, JSON.stringify(rows.map((r) => [r.agent, r.sent, r.received])));
check("ledger: a rework request is noted on the sender, a failure on the agent", by("checker").notes.some((n) => /sent work back to the Writer/.test(n)) && by("writer").notes.some((n) => /a step failed/.test(n)));
check("ledger: an overruled pick is noted on the coordinator", by("coordinator").notes.some((n) => /overruled its pick 1 time\b/.test(n)), by("coordinator").notes.join("|"));
check("ledger: an empty run gives an empty ledger", buildLedger([]).length === 0);
check("ledger: it reads only events, so garbage events do not crash it", buildLedger([{ type: "nonsense", seq: 1, at: 1 }]).length === 0);

const hs = events.filter((e) => e.type === "handoff").map((e) => e.handoff);
check("headline: counts specialists, hand-offs and rework", headline(rows, hs) === "3 specialists worked under the Coordinator, with 5 hand-offs (3 directly between specialists). The Checker sent work back 1 time.", headline(rows, hs));
check("headline: a run with no specialist work says so", headline(buildLedger([ev({ type: "think", agent: "coordinator", step: 1, text: "t" })]), []) === "No specialist did any work in this run.");
check("ledgerLine: one plain line per agent", ledgerLine(by("writer")) === "Writer: 6 questions. 2 jobs, 1 failed, 1 hand-off sent, 2 received, took about 4 s.", ledgerLine(by("writer")));
check("ledgerLine: the coordinator is described by decisions, not jobs", ledgerLine(by("coordinator")).startsWith("Coordinator: made 2 decisions; a plan of 3 steps; the final report."), ledgerLine(by("coordinator")));
check("handoffLine: reads like a sentence", handoffLine(hs[3]) === "Writer → Checker (review): 6 questions to check", handoffLine(hs[3]));
check("agentById: unknown id falls back to the coordinator, never crashes", agentById("nobody").id === "coordinator");

console.log(fails.length ? "\nFAILED: " + fails.join("; ") : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
