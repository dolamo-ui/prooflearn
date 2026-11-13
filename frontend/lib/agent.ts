export const APP_NAME = "ProofLearn";
export const TAGLINE = "Teach me anything. Prove I learned it.";

export type Topic = string;
export type Lesson = {
  topic: Topic;
  title: string;
  background: string;
  objective: string;
  explain: string;
  keyPoints: string[];
  example: string;
  practice: string;
  practiceAnswer: string;
  commonMistakes: string[];
  retry: string;
};
export type Course = { title: string; lessons: Lesson[] };
export type LessonPlanStep = { minutes: number; stage: string; teacherAction: string; studentAction: string };
export type TeacherPlan = {
  learningGoal: string;
  durationMinutes: number;
  alignment: string;
  materials: string[];
  steps: LessonPlanStep[];
  checksForUnderstanding: string[];
  supportStrategies: string[];
  coaching: { keepDoing: string[]; tryNext: string[]; reflectionQuestions: string[] };
};
export type ReteachStep = { minutes: number; teacherAction: string; studentAction: string };
export type TopicReteachPlan = {
  topic: string;
  likelyReasons: string[];
  steps: ReteachStep[];
  checkForUnderstanding: string;
  followUp: string;
};
type QuestionBase = {
  id: string;
  topic: Topic;
  text: string;
  why: string;
  /** server signature of the answer key (set by the server, checked when marking) */
  sig?: string;
  /** the passage of the notes this question came from (shown to the learner as proof) */
  ref?: string;
};
export type Question = QuestionBase & (
  | {
    kind: "choice";
    options: string[];
    answer: number;
    expectedAnswer?: never;
  }
  | {
    kind: "explain";
    options: [];
    answer: -1;
    expectedAnswer: string;
  }
  | {
    kind: "order";
    options: string[];
    answer: string[];
    expectedAnswer?: never;
  }
);
export type TestAnswer = number | string | string[] | null;
export type TraceKind = "plan" | "tool" | "critic" | "fix" | "mark" | "adapt" | "report";
export type TraceItem = { id: number; kind: TraceKind; text: string };
export type Level = "Beginner" | "Intermediate" | "Advanced";
export type Finding = { id: string; action: "approved" | "fixed" | "removed"; problem: string };
export type HistoryItem = { id: number; date: string; title: string; first: string; topics: Record<string, number> };

/* ---------- Marking (exact match against the answer key) ---------- */

export function score(qs: Question[], ans: TestAnswer[], grades: (boolean | undefined)[] = []) {
  const by: Record<string, { right: number; total: number }> = {};
  let right = 0;
  qs.forEach((q, i) => {
    if (!by[q.topic]) by[q.topic] = { right: 0, total: 0 };
    by[q.topic].total += 1;
    const response = ans[i];
    const correct = grades[i] ?? (
      q.kind === "choice"
        ? response === q.answer
        : q.kind === "order" && Array.isArray(response)
          ? q.answer.length === response.length && q.answer.every((item, index) => item === response[index])
          : false
    );
    if (correct) {
      by[q.topic].right += 1;
      right += 1;
    }
  });
  const weak = Object.keys(by).filter((t) => by[t].right < by[t].total);
  const pct: Record<string, number> = {};
  Object.keys(by).forEach((t) => (pct[t] = Math.round((100 * by[t].right) / by[t].total)));
  return { by, right, weak, pct };
}
