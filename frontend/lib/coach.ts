/* The autonomous LEARNING COACH (learner side).
   Same idea as the teacher's colleague (lib/colleague.ts) but built around the learner:
   the AI chooses what happens next, the learner takes part (reads, answers), and the loop
   pauses while the learner does. The goal is PROOF: a topic counts as learned only when the
   learner scores TARGET% or more on questions that CODE marked. The AI never marks anything
   and never decides who learned what; it only chooses the next step. */

export type CoachTool = "build_lessons" | "teach_topic" | "quiz_learner" | "finish";

export const TARGET = 70;                 // % a topic needs to count as learned (same target the teacher screens use)
export const COACH_STEPS_DEFAULT = 14;
export const COACH_STEPS_HARD = 20;
export const MAX_TEACH_PER_TOPIC = 3;     // after 3 tries the coach stops pushing the same topic and says so
const MAX_ROUNDS = 5;

export type Knows = "nothing" | "a little" | "a lot";

export type CoachSnapshot = {
  knows: Knows;
  lessons: string[];                       // topics of the course
  taught: Record<string, number>;          // how many times each topic was shown
  unsure: string[];                        // topics the learner said "still unsure" about the last time they saw them
  scores: Record<string, number>;          // latest marked % per topic (only topics already tested)
  rounds: number;                          // tests completed
  taughtSinceQuiz: number;                 // topics shown since the last test
  failures: number;                        // tool errors in a row
  uses: Partial<Record<CoachTool, number>>;
};

export type CoachObservation = { step: number; action: CoachTool; ok: boolean; text: string };

export type CoachDecision = {
  thought: string;                         // spoken to the learner, so it is written in plain, kind words
  action: CoachTool;
  args: { topic: string; outcome: string; summary: string };
  plan: string[];
  fallback?: string;
  forced?: boolean;
};

export const weakTopics = (s: CoachSnapshot) => s.lessons.filter((t) => s.scores[t] !== undefined && s.scores[t] < TARGET);
export const isMastered = (s: CoachSnapshot) => s.lessons.length > 0 && s.lessons.every((t) => (s.scores[t] ?? -1) >= TARGET);
export const teachable = (s: CoachSnapshot) => s.lessons.filter((t) => (s.taught[t] || 0) < MAX_TEACH_PER_TOPIC);

export type CoachToolSpec = {
  name: CoachTool;
  does: string;
  args: string;
  maxUses: number;
  blocked: (s: CoachSnapshot) => string | null;
};

export const COACH_TOOLS: CoachToolSpec[] = [
  {
    name: "build_lessons", maxUses: 2,
    does: "Write a short course of 3-5 lessons for the learner's goal (from their notes if they gave any). The learner does not see this step; it just prepares the topics.",
    args: '{"topic":"subject, max 200 characters","outcome":"what the learner wants to be able to do, max 300 characters"}',
    blocked: (s) => (s.lessons.length >= 2 ? "the lessons already exist" : null),
  },
  {
    name: "teach_topic", maxUses: 12,
    does: "Show the learner ONE topic to read. The first time it is the full lesson; every later time it is a different, everyday explanation. The learner says whether they understood or are still unsure.",
    args: '{"topic":"one of the lesson topics, exactly as written"}',
    blocked: (s) => {
      if (s.lessons.length < 2) return "build the lessons first";
      if (isMastered(s)) return "the learner has already proven every topic";
      return teachable(s).length ? null : `every topic has already been shown ${MAX_TEACH_PER_TOPIC} times`;
    },
  },
  {
    name: "quiz_learner", maxUses: MAX_ROUNDS,
    does: "Give the learner a short checked test and MARK it with code. The first test covers every topic; later tests cover only the topics still below the target. The marks decide what has been learned.",
    args: "{}",
    blocked: (s) => {
      if (s.lessons.length < 2) return "build the lessons first";
      if (isMastered(s)) return "the learner has already proven every topic";
      if (s.rounds >= 1 && s.taughtSinceQuiz === 0) return "teach a weak topic before testing again";
      return null;
    },
  },
  {
    name: "finish", maxUses: 99,
    does: "Stop and give the learner a short, honest, encouraging message about where they are. Say what they have proven (from the scores only) and what to do next.",
    args: '{"summary":"2-4 kind, plain sentences to the learner"}',
    blocked: (s) => {
      if (s.failures >= 2) return null;
      if (s.lessons.length > 0 && s.rounds === 0) return "the learner has not been tested yet, so there is no proof of anything";
      if (weakTopics(s).length > 0 && s.rounds < 2) return "there are weak topics: reteach them and test again first";
      return null;
    },
  },
];

export const coachToolByName = (n: unknown) => COACH_TOOLS.find((t) => t.name === n);

export function availableCoachTools(s: CoachSnapshot): CoachToolSpec[] {
  return COACH_TOOLS.filter((t) => {
    if ((s.uses[t.name] || 0) >= t.maxUses) return false;
    if (t.name === "finish" && s.lessons.length === 0 && s.failures < 2) return false;   // nothing made yet: try first
    return !t.blocked(s);
  });
}

/** The topic to teach next when the AI gave none or a bad one: unsure topics first, then the lowest score, then one never shown. */
export function nextTopicToTeach(s: CoachSnapshot): string {
  const open = teachable(s);
  if (!open.length) return s.lessons[0] || "";
  const weak = open.filter((t) => weakTopics(s).includes(t));
  const unsure = weak.filter((t) => s.unsure.includes(t));
  const pool = unsure.length ? unsure : weak.length ? weak : open.filter((t) => !(s.taught[t] || 0));
  const list = pool.length ? pool : open;
  return [...list].sort((a, b) => (s.scores[a] ?? 50) - (s.scores[b] ?? 50))[0];
}

/** If the AI's choice cannot be used, this is the sensible next step. A safety net only. */
export function fallbackCoach(s: CoachSnapshot, avail: CoachToolSpec[]): { action: CoachTool; topic: string } {
  const has = (n: CoachTool) => avail.some((t) => t.name === n);
  if (!s.lessons.length && has("build_lessons")) return { action: "build_lessons", topic: "" };
  if (s.rounds === 0 && s.knows === "nothing" && !Object.keys(s.taught).length && has("teach_topic")) return { action: "teach_topic", topic: nextTopicToTeach(s) };
  if (s.rounds === 0 && has("quiz_learner")) return { action: "quiz_learner", topic: "" };
  if (s.taughtSinceQuiz > 0 && has("quiz_learner")) return { action: "quiz_learner", topic: "" };
  if (has("teach_topic")) return { action: "teach_topic", topic: nextTopicToTeach(s) };
  return { action: "finish", topic: "" };
}
