/* The autonomous "digital colleague".
   One loop: look at the goal and what is done so far -> the AI picks ONE tool -> the tool runs ->
   the result goes back to the AI -> repeat, until the AI says it is finished (or a safety limit is hit).
   This file holds the parts the browser and the server agree on: the tool catalogue and the rules.
   To add a tool later: add it to TOOLS below, then add its
   runner in components/Colleague.tsx. The AI will see it automatically. */

export type ToolName =
  | "search_notes" | "web_search" | "build_lessons" | "write_questions" | "check_questions" | "plan_lesson"
  | "share_test" | "read_results" | "draft_email" | "finish";

/** One web result kept for the report's Sources list. */
export type WebHit = { title: string; url: string; snippet: string };

/** What reading the class results found. Totals only: learner nicknames and written answers never leave the browser. */
export type ResultsSummary = { title: string; count: number; average: number; weak: string[] };

export type Snapshot = {
  webSearch: boolean;                // is web search set up? (the SERVER decides this, whatever the browser says)
  sources: number;                   // how many web sources have been found so far
  noteChars: number;                 // how much teacher notes there are (0 = none)
  lessons: string[];                 // topics of the lessons built so far
  questions: number;                 // how many test questions exist right now
  checked: boolean;                  // have the CURRENT questions been through the checker?
  lastCheck: { approved: number; fixed: number; removed: number } | null;
  planMinutes: number | null;        // length of the lesson plan, if one exists
  canShare: boolean;                 // did the teacher tick "you may share the test with learners"?
  shareCode: string | null;          // the code of the test shared in this run, if any
  savedTests: string[];              // titles of tests already shared from this device (read_results can look at them)
  results: ResultsSummary | null;    // the last results that were read
  failures: number;                  // tool errors in a row
  uses: Partial<Record<ToolName, number>>;
};

export type Observation = { step: number; action: ToolName; ok: boolean; text: string };

export type Decision = {
  thought: string;
  action: ToolName;
  args: Record<string, unknown>;
  plan: string[];                    // only when the AI made or changed its plan this step
  fallback?: string;                 // set when the server had to choose because the AI's pick was not allowed
  forced?: boolean;                  // set when the step budget ran out
};

const CHECK_MAX = 4;
export const MAX_STEPS_DEFAULT = 10;
export const MAX_STEPS_HARD = 14;

export type ToolSpec = {
  name: ToolName;
  /** what the AI is told this tool does */
  does: string;
  /** the arguments the AI may give (all optional) */
  args: string;
  /** the most times it may be used in one run */
  maxUses: number;
  /** returns why the tool cannot be used right now, or null when it can */
  blocked: (s: Snapshot) => string | null;
};

export const TOOLS: ToolSpec[] = [
  {
    name: "search_notes", maxUses: 4,
    does: "Look through the teacher's notes for passages about something. Use it to find out what the notes really cover before you build anything.",
    args: '{"query":"2-8 words to look for"}',
    blocked: (s) => (s.noteChars > 0 ? null : "there are no notes"),
  },
  {
    name: "web_search", maxUses: 3,
    does: "Search the web to check facts, find current information or find sources the notes do not have. What it finds is kept and listed under Sources in the report, and is used when you build lessons afterwards. Do it BEFORE build_lessons. Skip it when the notes already answer the goal.",
    args: '{"query":"3-10 words to search for"}',
    blocked: (s) => (s.webSearch ? null : "web search is not set up"),
  },
  {
    name: "build_lessons", maxUses: 2,
    does: "Write a short course of 3-5 lessons from the notes (or from general knowledge if there are no notes). Calling it again REPLACES the lessons and throws away any questions and plan made from the old ones.",
    args: '{"topic":"subject, max 200 characters","outcome":"what learners should be able to do, max 300 characters"}',
    blocked: (s) => (s.shareCode ? "the test is already shared, so the lessons cannot be rebuilt" : null),
  },
  {
    name: "write_questions", maxUses: 3,
    does: "Write a test (choice, written and ordering questions) that covers every lesson. Calling it again REPLACES the questions.",
    args: "{}",
    blocked: (s) => (s.shareCode ? "the test is already shared, so the questions cannot be replaced" : s.lessons.length >= 2 ? null : "build the lessons first"),
  },
  {
    name: "check_questions", maxUses: CHECK_MAX,
    does: "A strict second AI checks every question: is it supported by the lessons, clear, and has the right answer? It fixes or removes bad ones. A check PASSES when it fixes and removes nothing.",
    args: "{}",
    blocked: (s) => (s.questions > 0 ? null : "write the questions first"),
  },
  {
    name: "plan_lesson", maxUses: 2,
    does: "Write a timed lesson plan (teacher and student actions, checks for understanding, coaching) for the lessons.",
    args: '{"minutes":"lesson length, 20-180"}',
    blocked: (s) => (s.lessons.length >= 2 ? null : "build the lessons first"),
  },
  {
    name: "share_test", maxUses: 1,
    does: "Publish the finished test so learners can open it with a code, link or QR code (the same as the Tests and classwork screen). Only when the goal asks for the test to be shared or given to learners. Once shared, the test can no longer be rewritten. It only works for a test that has just PASSED the checker with no changes.",
    args: "{}",
    blocked: (s) =>
      !s.canShare ? "the teacher has not allowed sharing in this run"
      : s.shareCode ? "the test is already shared"
      : s.questions === 0 ? "write the questions first"
      : !s.checked || !s.lastCheck || s.lastCheck.fixed > 0 || s.lastCheck.removed > 0 ? "the test has to pass the checker with no changes first"
      : null,
  },
  {
    name: "read_results", maxUses: 2,
    does: "Read how learners did on a test the teacher has already shared from this device: how many handed in, the class average, the weak topics and the hardest questions. You only see totals, never learner names or answers. A test that was only just shared has no answers yet.",
    args: '{"test":"title or code of the test (leave empty for the one shared in this run or the newest)"}',
    blocked: (s) => (s.savedTests.length > 0 ? null : "no test has been shared from this device yet"),
  },
  {
    name: "draft_email", maxUses: 2,
    does: "Write a DRAFT email for the teacher to review. It is never sent: the teacher copies it or opens it in their own email app. If a test was shared, its link and code are added automatically, so never write a link or code yourself.",
    args: '{"to":"learners, parents or colleagues","about":"what the email should say, max 200 characters"}',
    blocked: (s) => (s.lessons.length > 0 || s.shareCode || s.results ? null : "there is nothing to write about yet"),
  },
  {
    name: "finish", maxUses: 99,
    does: "Stop, because the goal is met (or cannot be met). Give the teacher a short report of what you made and anything they should double-check.",
    args: '{"summary":"2-4 plain sentences for the teacher"}',
    // The same rule the rest of ProofLearn follows: a test nobody checked is not handed over as "ready".
    // (If the checker has been used up, finishing is allowed, but the report says the test is NOT approved.)
    blocked: (s) => (s.questions > 0 && !s.checked && (s.uses.check_questions || 0) < CHECK_MAX ? "the test has not been through the checker yet" : null),
  },
];

export const toolByName = (n: unknown) => TOOLS.find((t) => t.name === n);

/** The tools the AI may use right now (a tool that is blocked or used up is not offered). */
export function availableTools(s: Snapshot, stuckOk = true): ToolSpec[] {
  return TOOLS.filter((t) => {
    if ((s.uses[t.name] || 0) >= t.maxUses) return false;
    if (t.name === "finish") {
      // Finishing with nothing made is only allowed after repeated failures (otherwise the AI just has to try).
      if (s.lessons.length === 0 && !(stuckOk && s.failures >= 2)) return false;
    }
    return !t.blocked(s);
  });
}

/** If the AI's choice cannot be used, this is the sensible next step. Used only as a safety net. */
export function fallbackAction(s: Snapshot, avail: ToolSpec[]): ToolName {
  const has = (n: ToolName) => avail.some((t) => t.name === n);
  if (s.lessons.length === 0 && has("build_lessons")) return "build_lessons";
  if (s.questions === 0 && has("write_questions")) return "write_questions";
  if (s.questions > 0 && !s.checked && has("check_questions")) return "check_questions";
  if (s.planMinutes === null && has("plan_lesson")) return "plan_lesson";
  return "finish";
}
