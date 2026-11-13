"use client";
import { downloadHtmlPdf, saveBlob, wordPage } from "../lib/pdf";
import { api as postJSON, readFileText } from "../lib/client";
import { useEffect, useRef, useState } from "react";
import { APP_NAME, TAGLINE, score } from "../lib/agent";
import { WaitBanner } from "./ui";
import { ProofCard, SAMPLE_PAPER, SelfCheckCard, TeacherInsight, sampleClassCounts } from "./extras";
import type { Course, Finding, HistoryItem, Lesson, Level, Question, TeacherPlan, TestAnswer, TopicReteachPlan, TraceItem, TraceKind } from "../lib/agent";

type Phase = "home" | "plan" | "learn" | "making" | "test" | "marking" | "reteach" | "retest" | "report";
type AssignmentKind = "test" | "exam" | "classwork" | "homework" | "assignment" | "assessment" | "practice";
type SharedAssignment = {
  version: 1;
  id: string;
  title: string;
  kind: AssignmentKind;
  instructions: string;
  course: Course;
  questions: Question[];
  createdAt: string;
};
type MarkedResponse = { correct: boolean; feedback: string };
type SharedSubmission = {
  version: 1;
  assignment: SharedAssignment;
  learnerName: string;
  answers: TestAnswer[];
  marks: Record<string, MarkedResponse>;
  helpfulness: number;
  difficulty: number;
  ratingComment: string;
  submittedAt: string;
};
type Emit = (k: TraceKind, t: string, ms?: number) => Promise<void>;
type SpeechResultLike = ArrayLike<{ transcript: string }>;
type SpeechRecognitionEventLike = { resultIndex: number; results: ArrayLike<SpeechResultLike> };
type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const LABEL: Record<TraceKind, string> = { plan: "Plan", tool: "Doing", critic: "Checker", fix: "Fix", mark: "Marking", adapt: "Adapting", report: "Report" };
const STEPS: [string, string][] = [
  ["Learn", "Tell it what you want to learn. It writes short, friendly lessons."],
  ["Test", "It writes a quick test, and a second AI checks every question is fair."],
  ["Improve", "Missed something? It explains it a different way and retests you."],
  ["Result", "Get a learning book to keep, and a plan for teachers."],
];
const LEVELS: Level[] = ["Beginner", "Intermediate", "Advanced"];
const ASSIGNMENT_LABEL: Record<AssignmentKind, string> = {
  test: "Test", exam: "Exam", classwork: "Classwork", homework: "Homework",
  assignment: "Assignment", assessment: "Assessment", practice: "Practice test",
};
const HKEY = "prooflearn.history";
const MAXSRC = 12000;
const MAX_SHARE_LENGTH = 100000;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function encodeShare(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if ("CompressionStream" in window) {
    const stream = new Blob([bytesToArrayBuffer(bytes)]).stream().pipeThrough(new CompressionStream("gzip"));
    return `g${bytesToBase64Url(new Uint8Array(await new Response(stream).arrayBuffer()))}`;
  }
  return `j${bytesToBase64Url(bytes)}`;
}

async function decodeShare<T>(value: string): Promise<T> {
  const bytes = base64UrlToBytes(value.slice(1));
  const payload = value[0] === "g" && "DecompressionStream" in window
    ? new Response(new Blob([bytesToArrayBuffer(bytes)]).stream().pipeThrough(new DecompressionStream("gzip")))
    : value[0] === "j"
      ? new Response(bytesToArrayBuffer(bytes))
      : null;
  if (!payload) throw new Error("This share link needs a newer browser. Open it in an up-to-date browser.");
  return JSON.parse(await payload.text()) as T;
}

function isAnswered(answer: TestAnswer): boolean {
  return typeof answer === "number" ? answer >= 0
    : typeof answer === "string" ? Boolean(answer.trim())
      : Array.isArray(answer);
}

function isAssignment(value: unknown): value is SharedAssignment {
  if (!value || typeof value !== "object") return false;
  const item = value as SharedAssignment;
  const raw = value as { course?: { title?: unknown; lessons?: unknown } };
  const lessons = raw.course?.lessons;
  if (typeof raw.course?.title !== "string" || !Array.isArray(lessons) || lessons.length < 2) return false;
  const validLessons = lessons.every((lesson: any) =>
    lesson && typeof lesson.topic === "string" && typeof lesson.title === "string" &&
    typeof lesson.objective === "string" && typeof lesson.explain === "string" &&
    Array.isArray(lesson.keyPoints) && lesson.keyPoints.length >= 2 &&
    typeof lesson.example === "string" && typeof lesson.practice === "string" &&
    typeof lesson.practiceAnswer === "string" && Array.isArray(lesson.commonMistakes) &&
    lesson.commonMistakes.length > 0 && typeof lesson.retry === "string"
  );
  if (!validLessons) return false;
  const topics = lessons.map((lesson: any) => lesson.topic as string);
  return item.version === 1 && typeof item.id === "string" && typeof item.title === "string" &&
    ["test", "exam", "classwork", "homework", "assignment", "assessment", "practice"].includes(item.kind) &&
    typeof item.instructions === "string" && Array.isArray(item.questions) && item.questions.length > 0 &&
    Array.isArray(topics) && topics.length >= 2 &&
    item.questions.every((question) => {
      if (!question || typeof question.id !== "string" || typeof question.topic !== "string" ||
        !topics.includes(question.topic) || typeof question.text !== "string" || typeof question.why !== "string") return false;
      if (question.kind === "choice") return Array.isArray(question.options) && question.options.length === 4 &&
        Number.isInteger(question.answer) && question.answer >= 0 && question.answer < 4;
      if (question.kind === "explain") return typeof question.expectedAnswer === "string";
      if (question.kind === "order") return Array.isArray(question.options) && question.options.length >= 3 &&
        Array.isArray(question.answer) && question.answer.length === question.options.length &&
        question.answer.every((step) => typeof step === "string" && question.options.includes(step));
      return false;
    });
}

function isSharedSubmission(value: unknown): value is SharedSubmission {
  if (!value || typeof value !== "object") return false;
  const item = value as SharedSubmission;
  return item.version === 1 && isAssignment(item.assignment) &&
    Array.isArray(item.answers) && item.answers.length === item.assignment.questions.length &&
    item.answers.every((answer, index) => {
      const question = item.assignment.questions[index];
      if (question.kind === "choice") return typeof answer === "number" && Number.isInteger(answer) && answer >= 0 && answer < question.options.length;
      if (question.kind === "explain") return typeof answer === "string" && answer.length <= 1200;
      return Array.isArray(answer) && answer.length === question.options.length &&
        answer.every((step) => typeof step === "string" && question.options.includes(step));
    }) &&
    item.assignment.questions.every((question) => typeof item.marks?.[question.id]?.correct === "boolean" &&
      typeof item.marks[question.id].feedback === "string") &&
    typeof item.learnerName === "string" && Number.isInteger(item.helpfulness) &&
    item.helpfulness >= 1 && item.helpfulness <= 5 && Number.isInteger(item.difficulty) &&
    item.difficulty >= 1 && item.difficulty <= 5 && typeof item.ratingComment === "string" &&
    typeof item.submittedAt === "string";
}

function download(name: string, body: string) {
  saveBlob(new Blob([wordPage(name.replace(/\.doc$/, ""), body)], { type: "application/msword" }), name);
}

function api<T>(action: string, payload: object): Promise<T> {
  return postJSON<T>("/api/agent", { action, ...payload });   // waits and retries by itself when the AI needs a short rest
}

function loadHistory(): HistoryItem[] {
  try { return JSON.parse(localStorage.getItem(HKEY) || "[]"); } catch { return []; }
}

function Bar({ label, pct, note }: { label: string; pct: number; note?: string }) {
  return (
    <div className="bar">
      <span>{label}</span>
      <div className="track"><i className={pct < 60 ? "low" : ""} style={{ width: pct + "%" }} /></div>
      <b>{pct}%</b>
      {note ? <em>{note}</em> : null}
    </div>
  );
}

export function Quiz({ qs, vals, onPick }: { qs: Question[]; vals: TestAnswer[]; onPick: (i: number, o: TestAnswer) => void }) {
  const dragged = useRef<number | null>(null);
  return (
    <div>
      {qs.map((q, i) => (
        <fieldset key={q.id} className="q">
          <legend>{i + 1}. {q.text}</legend>
          {q.kind === "choice" && q.options.map((o, j) => (
            <label key={j} className={"opt" + (vals[i] === j ? " on" : "")}>
              <input type="radio" name={q.id} checked={vals[i] === j} onChange={() => onPick(i, j)} /> <span className="letter">{"ABCD"[j]}</span> {o}
            </label>
          ))}
          {q.kind === "explain" && (
            <label className="answer-field">
              <span>Explain it in your own words</span>
              <textarea rows={4} maxLength={1200} value={typeof vals[i] === "string" ? vals[i] : ""}
                onChange={(event) => onPick(i, event.target.value)} placeholder="Write what you understand, using your own words." />
            </label>
          )}
          {q.kind === "order" && (() => {
            const order = Array.isArray(vals[i]) ? vals[i] : q.options;
            const move = (from: number, to: number) => {
              if (to < 0 || to >= order.length) return;
              const next = [...order];
              const [item] = next.splice(from, 1);
              next.splice(to, 0, item);
              onPick(i, next);
            };
            return (
              <div>
                <p><small>Drag the steps into order, or use the move buttons.</small></p>
                <ol className="order-list" aria-label={`Steps for question ${i + 1}`}>
                  {order.map((step, index) => (
                    <li key={step} draggable onDragStart={() => { dragged.current = index; }}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => { event.preventDefault(); if (dragged.current !== null) move(dragged.current, index); dragged.current = null; }}
                      onDragEnd={() => { dragged.current = null; }}>
                      <span className="drag-grip" aria-hidden="true">⋮⋮</span>
                      <span>{step}</span>
                      <span className="move-controls">
                        <button type="button" className="ghost" aria-label={`Move step ${index + 1} up`} disabled={index === 0} onClick={() => move(index, index - 1)}>Up</button>
                        <button type="button" className="ghost" aria-label={`Move step ${index + 1} down`} disabled={index === order.length - 1} onClick={() => move(index, index + 1)}>Down</button>
                      </span>
                    </li>
                  ))}
                </ol>
                {!Array.isArray(vals[i]) && <button type="button" className="ghost" onClick={() => onPick(i, order)}>Confirm this order</button>}
              </div>
            );
          })()}
        </fieldset>
      ))}
    </div>
  );
}

export function answerText(q: Question): string {
  if (q.kind === "choice") return q.options[q.answer] || "";
  if (q.kind === "explain") return q.expectedAnswer || "";
  return Array.isArray(q.answer) ? q.answer.join(" → ") : "";
}

function responseText(q: Question, answer: TestAnswer): string {
  if (q.kind === "choice") return typeof answer === "number" ? q.options[answer] || "" : "";
  if (q.kind === "order") return Array.isArray(answer) ? answer.join(" → ") : "";
  return typeof answer === "string" ? answer : "";
}

function Stepper({ phase }: { phase: Phase }) {
  const at = { home: -1, plan: 0, learn: 0, making: 1, test: 1, marking: 2, reteach: 2, retest: 2, report: 3 }[phase];
  return (
    <ol className="stepper" aria-label="Your progress">
      {STEPS.map(([n], i) => (
        <li key={n} className={i < at ? "done" : i === at ? "now" : ""} aria-current={i === at ? "step" : undefined}>
          <span>{i < at ? "✓" : i + 1}</span> {n}
        </li>
      ))}
    </ol>
  );
}

function SourceBox({ source, setSource, id }: { source: string; setSource: (s: string) => void; id: string }) {
  const [fname, setFname] = useState("");
  const [msg, setMsg] = useState("");
  const onFile = async (f?: File) => {
    if (!f) return;
    let t = "";
    try {
      setMsg("Reading your file…");
      t = await readFileText(f, (m) => setMsg(m));
    } catch (e: any) { setMsg(e.message || "I could not read that file."); return; }
    setFname(f.name);
    setSource(t.slice(0, MAXSRC));
    setMsg(t.length > MAXSRC ? `Your file is long. I will use the first ${MAXSRC.toLocaleString()} characters.` : "");
  };
  return (
    <details className="src">
      <summary>Use my own notes, memo or past paper (optional)</summary>
      <p><small>The AI will teach and test <b>only</b> from what you add here.</small></p>
      <textarea id={id} aria-label="Your notes or memo" rows={6} maxLength={MAXSRC} placeholder="Paste your notes here…" value={source} onChange={(e) => setSource(e.target.value)} />
      <p><input type="file" accept=".pdf,.docx,.txt,.md,.csv" aria-label="Upload a PDF, Word or text file" onChange={(e) => onFile(e.target.files?.[0])} /> {fname && <small>Loaded {fname}</small>} <button className="link" onClick={() => { setSource(SAMPLE_PAPER); setFname("sample past paper"); setMsg(""); }}>Try a sample past paper</button></p>
      <p><small>{source.length.toLocaleString()} / {MAXSRC.toLocaleString()} characters{source && <> · <button className="link" onClick={() => { setSource(""); setFname(""); setMsg(""); }}>Clear</button></>}</small></p>
      {msg && <p className="warn">{msg}</p>}
    </details>
  );
}

export default function App({ embedded = false, startTab = "learner", onHome }: { embedded?: boolean; startTab?: "learner" | "teacher"; onHome?: () => void } = {}) {
  const [phase, setPhase] = useState<Phase>("home");
  const [tab, setTab] = useState<"learner" | "teacher">(startTab);
  const [input, setInput] = useState("");
  const [outcome, setOutcome] = useState("");
  const [level, setLevel] = useState<Level>("Beginner");
  const [source, setSource] = useState("");
  const [course, setCourse] = useState<Course>({ title: "", lessons: [] });
  const [lessonIndex, setLessonIndex] = useState(0);
  const [unitStart, setUnitStart] = useState(0);
  const [qs, setQs] = useState<Question[]>([]);
  const [trace, setTrace] = useState<TraceItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [fileNote, setFileNote] = useState("");   // message after a PDF download
  const downloadPdf = async (name: string, title: string, html: string) => {
    try { const r = await downloadHtmlPdf(name, title, html); setFileNote(r.lossy ? "PDF downloaded. A few special characters cannot be shown in a PDF and appear as “?”. Use the Word download to keep them." : "PDF downloaded."); }
    catch { setFileNote("I could not make the PDF. Try the Word download instead."); }
  };
  const [answers, setAnswers] = useState<TestAnswer[]>([]);
  const [grades, setGrades] = useState<(boolean | undefined)[]>([]);
  const [retest, setRetest] = useState<Question[]>([]);
  const [rAns, setRAns] = useState<TestAnswer[]>([]);
  const [rGrades, setRGrades] = useState<(boolean | undefined)[]>([]);
  const [latest, setLatest] = useState<Record<string, number>>({});
  const [taught, setTaught] = useState<string[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [status, setStatus] = useState<"checking" | "connected" | "unavailable">("checking");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [tBusy, setTBusy] = useState(false);
  const [tMsg, setTMsg] = useState("");
  const [tGoal, setTGoal] = useState("");
  const [tOutcome, setTOutcome] = useState("");
  const [lessonMinutes, setLessonMinutes] = useState(50);
  const [tCourse, setTCourse] = useState<Course | null>(null);
  const [tQs, setTQs] = useState<Question[]>([]);
  const [teacherPlan, setTeacherPlan] = useState<TeacherPlan | null>(null);
  const [classCounts, setClassCounts] = useState<Record<string, { assessed: string; met: string }>>({});
  const [reteachPlans, setReteachPlans] = useState<TopicReteachPlan[]>([]);
  const [classMsg, setClassMsg] = useState("");
  const [classBusy, setClassBusy] = useState(false);
  const [assignmentKind, setAssignmentKind] = useState<AssignmentKind>("homework");
  const [assignmentInstructions, setAssignmentInstructions] = useState("");
  const [assignmentLink, setAssignmentLink] = useState("");
  const [shareMsg, setShareMsg] = useState("");
  const [sharedMode, setSharedMode] = useState<"student" | "review" | "invalid" | null>(null);
  const [sharedAssignment, setSharedAssignment] = useState<SharedAssignment | null>(null);
  const [sharedSubmission, setSharedSubmission] = useState<SharedSubmission | null>(null);
  const [sharedAnswers, setSharedAnswers] = useState<TestAnswer[]>([]);
  const [learnerName, setLearnerName] = useState("");
  const [helpfulness, setHelpfulness] = useState(0);
  const [difficulty, setDifficulty] = useState(0);
  const [ratingComment, setRatingComment] = useState("");
  const [sharedBusy, setSharedBusy] = useState(false);
  const [sharedMsg, setSharedMsg] = useState("");
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewMsg, setReviewMsg] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [tutorQuestion, setTutorQuestion] = useState("");
  const [tutorReply, setTutorReply] = useState("");
  const [tutorBusy, setTutorBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const idRef = useRef(0);
  const runRef = useRef(0);
  const retry = useRef<(() => void) | null>(null);
  const saved = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    setHistory(loadHistory());
    fetch("/api/agent")
      .then((r) => {
        if (!r.ok) throw new Error("Could not check Groq AI status.");
        return r.json();
      })
      .then((d) => setStatus(d.live && d.provider === "groq" ? "connected" : "unavailable"))
      .catch(() => setStatus("unavailable"));
  }, []);

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    const separator = hash.indexOf("=");
    if (separator < 0) return;
    const mode = hash.slice(0, separator);
    const encoded = hash.slice(separator + 1);
    if (mode !== "assignment" && mode !== "submission") return;
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    if (!encoded || encoded.length > MAX_SHARE_LENGTH) {
      setSharedMsg("This share link is empty or too large to open.");
      setSharedMode("invalid");
      return;
    }
    void decodeShare<unknown>(encoded).then((value) => {
      if (mode === "assignment" && isAssignment(value)) {
        setSharedAssignment(value);
        setSharedAnswers(value.questions.map(() => null));
        setSharedMode("student");
        setTab("learner");
        return;
      }
      if (mode === "submission" && isSharedSubmission(value)) {
        const submission = value;
        setSharedAssignment(submission.assignment);
        setSharedSubmission(submission);
        setSharedMode("review");
        setTab("teacher");
        return;
      }
      setSharedMsg("This link does not contain a valid assignment or student submission.");
      setSharedMode("invalid");
    }).catch((error: unknown) => {
      setSharedMsg(error instanceof Error ? error.message : "This share link could not be opened.");
      setSharedMode("invalid");
    });
  }, []);

  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [trace]);
  useEffect(() => { if (phase !== "home") top.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }, [phase]);
  useEffect(() => () => {
    recognitionRef.current?.abort();
    window.speechSynthesis?.cancel();
  }, []);

  const run = async (fn: (e: Emit) => Promise<void>, back: Phase, again?: () => void) => {
    const t = ++runRef.current;
    setBusy(true);
    setError("");
    retry.current = again || null;
    const e: Emit = async (k, x, ms) => {
      await sleep(ms ?? 120);
      if (t !== runRef.current) throw new Error("stopped");
      setTrace((p) => [...p, { id: idRef.current++, kind: k, text: x }]);
    };
    try {
      await fn(e);
    } catch (err: any) {
      if (err?.message !== "stopped" && t === runRef.current) {
        setError(err?.message || "Something went wrong. Please try again.");
        setPhase(back);
      }
    } finally {
      if (t === runRef.current) setBusy(false);
    }
  };

  const resetWork = () => {
    setTrace([]); setAnswers([]); setGrades([]); setRetest([]); setRAns([]); setRGrades([]); setLatest({}); setTaught([]); setFindings([]); setQs([]); setNote(""); setError("");
    setLessonIndex(0); setUnitStart(0);
    saved.current = false;
  };

  const unitCourse = (): Course => ({ title: course.title, lessons: course.lessons.slice(unitStart) });
  const currentLesson = course.lessons[lessonIndex];
  const lastLesson = lessonIndex === course.lessons.length - 1;

  /* ---------- 1. Plan and teach ---------- */
  const begin = (goal: string) =>
    run(async (e) => {
      resetWork();
      setPhase("plan");
      await e("plan", `Goal: teach "${goal}" so the learner can "${outcome}" at ${level} level${source ? ", using their notes" : ""}.`, 0);
      await e("tool", "Writing your lessons with Groq…", 0);
      const { course: c } = await api<{ course: Course }>("course", { goal, outcome, level, source });
      setCourse(c);
      setLessonIndex(0);
      await e("tool", `Built ${c.lessons.length} lessons: ${c.lessons.map((l) => l.topic).join(", ")}`);
      setPhase("learn");
    }, "home", () => begin(goal));

  const continueCourse = () => {
    const previous = course;
    const nextStart = previous.lessons.length;
    run(async (e) => {
      setPhase("plan");
      await e("plan", `Continuing "${previous.title}" toward "${outcome}".`, 0);
      await e("tool", "Creating the next lessons in your course with Groq…", 0);
      const { lessons } = await api<{ lessons: Lesson[] }>("continue", {
        course: previous, goal: input, outcome, level, source,
      });
      setAnswers([]); setGrades([]); setRetest([]); setRAns([]); setRGrades([]); setLatest({}); setTaught([]); setFindings([]); setQs([]); setNote(""); setError("");
      saved.current = false;
      setCourse((current) => ({ ...current, lessons: [...current.lessons, ...lessons] }));
      setUnitStart(nextStart);
      setLessonIndex(nextStart);
      await e("tool", `Added ${lessons.length} lessons: ${lessons.map((lesson) => lesson.topic).join(", ")}`);
      setPhase("learn");
    }, "report", continueCourse);
  };

  /* ---------- 2. Write and check the test ---------- */
  const makeTest = (c: Course = unitCourse()) =>
    run(async (e) => {
      setPhase("making");
      setFindings([]);
      await e("tool", "Writing test questions with Groq…", 0);
      const d = await api<{ questions: Question[] }>("draft", { course: c, level, source });
      await e("tool", `Drafted ${d.questions.length} questions.`);
      await e("critic", "Groq is reviewing every question for fairness and correctness…", 0);
      const r = await api<{ questions: Question[]; findings: Finding[] }>("review", { course: c, level, source, questions: d.questions });
      for (const f of r.findings.filter((x) => x.action !== "approved")) {
        const n = d.questions.findIndex((q) => q.id === f.id) + 1;
        await e(f.action === "fixed" ? "fix" : "critic", `Question ${n}: ${f.problem} ${f.action === "fixed" ? "Fixed." : "Removed."}`);
      }
      const bad = r.findings.filter((x) => x.action !== "approved").length;
      await e("critic", bad ? `Checker: ${bad} question${bad > 1 ? "s" : ""} changed. All ${r.questions.length} remaining questions approved.` : `Checker: all ${r.questions.length} questions approved.`);
      setFindings(r.findings);
      setQs(r.questions);
      setAnswers(r.questions.map(() => null));
      setGrades([]);
      setPhase("test");
    }, "learn", () => makeTest(c));

  /* ---------- 3. Mark, then re-teach ---------- */
  const markWrittenAnswers = async (q: Question[], ans: TestAnswer[], c: Course) => {
    const written = q.flatMap((item, index) => item.kind === "explain" ? [{
      id: item.id,
      text: item.text,
      expectedAnswer: item.expectedAnswer,
      sig: item.sig,
      response: typeof ans[index] === "string" ? ans[index] : "",
    }] : []);
    if (!written.length) return q.map(() => undefined);
    const result = await api<{ grades: { id: string; correct: boolean }[] }>("grade", { course: c, source, responses: written });
    const byId = new Map(result.grades.map((grade) => [grade.id, grade.correct]));
    if (written.some((item) => !byId.has(item.id))) throw new Error("The AI did not mark every written answer. Please try again.");
    return q.map((item) => item.kind === "explain" ? byId.get(item.id) : undefined);
  };

  const submit = (ans: TestAnswer[], q: Question[] = qs, c: Course = unitCourse()) =>
    run(async (e) => {
      setPhase("marking");
      const marked = await markWrittenAnswers(q, ans, c);
      setAnswers(ans);
      setGrades(marked);
      const r = score(q, ans, marked);
      setLatest(r.pct);
      await e("mark", `${r.right} of ${q.length} correct. Written explanations were checked for meaning, not exact wording.`);
      if (r.weak.length) {
        await e("adapt", `Gap found in ${r.weak.join(", ")}. My first explanation did not work, so I will teach it another way and retest.`);
        setTaught(r.weak);
        await e("tool", "Writing new questions with Groq for the topics you missed…", 0);
        const d = await api<{ questions: Question[] }>("retest", { course: c, level, source, topics: r.weak, previous: q.map((x) => x.text) });
        setRetest(d.questions);
        setRAns(d.questions.map(() => null));
        setRGrades([]);
        setPhase("reteach");
      } else {
        await e("report", "No gaps found. Building your learning book and the teacher report.");
        setPhase("report");
      }
    }, "test", () => submit(ans, q, c));

  const submitRetest = (ans: TestAnswer[], rq: Question[]) =>
    run(async (e) => {
      setPhase("marking");
      const marked = await markWrittenAnswers(rq, ans, unitCourse());
      setRAns(ans);
      setRGrades(marked);
      const r = score(rq, ans, marked);
      setLatest((p) => ({ ...p, ...r.pct }));
      await e("mark", `Retest: ${r.right} of ${rq.length} correct after the new explanation.`);
      await e("report", "Building your learning book and the teacher report.");
      setPhase("report");
    }, "retest", () => submitRetest(ans, rq));

  /* ---------- 4. Practise again ---------- */
  const practise = (topics: string[]) =>
    run(async (e) => {
      setPhase("marking");
      await e("adapt", `Still shaky on ${topics.join(", ")}. Writing fresh questions.`, 0);
      const d = await api<{ questions: Question[] }>("retest", { course: unitCourse(), level, source, topics, previous: [...qs, ...retest].map((x) => x.text) });
      setTaught((p) => Array.from(new Set([...p, ...topics])));
      setRetest(d.questions);
      setRAns(d.questions.map(() => null));
      setRGrades([]);
      setPhase("retest");
    }, "report", () => practise(topics));

  const reset = () => {
    runRef.current++;
    setPhase("home"); setBusy(false);
    resetWork();
    setHistory(loadHistory());
  };
  const closeShared = () => {
    setSharedMode(null);
    setSharedAssignment(null);
    setSharedSubmission(null);
    setSharedAnswers([]);
    setAssignmentLink("");
    setSharedMsg("");
    setReviewMsg("");
    setReteachPlans([]);
  };
  const go = () => { if (status === "connected" && input.trim() && outcome.trim()) begin(input.trim()); };
  const pickA = (i: number, o: TestAnswer) => setAnswers((a) => a.map((v, j) => (j === i ? o : v)));
  const pickR = (i: number, o: TestAnswer) => setRAns((a) => a.map((v, j) => (j === i ? o : v)));

  /* ---------- save results on this device ---------- */
  useEffect(() => {
    if (phase !== "report" || saved.current) return;
    saved.current = true;
    const first = score(qs, answers, grades);
    const item: HistoryItem = { id: Date.now(), date: new Date().toISOString(), title: course.title, first: `${first.right}/${qs.length}`, topics: latest };
    try {
      const all = [item, ...loadHistory()].slice(0, 20);
      localStorage.setItem(HKEY, JSON.stringify(all));
      setHistory(all);
    } catch { /* storage may be blocked; that is fine */ }
  }, [phase, qs, answers, grades, course.title, latest]);

  const topics = unitCourse().lessons.map((l) => l.topic);
  const r = ["reteach", "retest", "report"].includes(phase) && qs.length ? score(qs, answers, grades) : null;
  const stillWeak = topics.filter((t) => latest[t] !== undefined && latest[t] < 100);
  const lessonOf = (t: string) => course.lessons.find((l) => l.topic === t);

  const sharedResult = sharedSubmission
    ? score(
      sharedSubmission.assignment.questions,
      sharedSubmission.answers,
      sharedSubmission.assignment.questions.map((question) => sharedSubmission.marks[question.id]?.correct)
    )
    : null;

  const sharedAssignmentView = sharedMode === "student" && sharedAssignment ? (
    <>
      <h2>{ASSIGNMENT_LABEL[sharedAssignment.kind]}: {sharedAssignment.title}</h2>
      <p>{sharedAssignment.instructions || "Complete each question. Your teacher will receive your answers and your feedback when you send back the result link."}</p>
      <p className="warn"><b>Demo link:</b> This assignment travels in the URL. It is not stored in a class database. Written answers are sent to Groq for marking. Do not enter sensitive personal information.</p>
      {!sharedSubmission ? (
        <>
          <label className="answer-field"><span>Your name (optional)</span><input value={learnerName} maxLength={80} onChange={(event) => setLearnerName(event.target.value)} placeholder="Enter your name for your teacher" /></label>
          <Quiz qs={sharedAssignment.questions} vals={sharedAnswers} onPick={(index, value) => setSharedAnswers((current) => current.map((answer, i) => i === index ? value : answer))} />
          <button className="btn" disabled={sharedBusy || sharedAnswers.filter(isAnswered).length !== sharedAssignment.questions.length} onClick={() => void submitSharedAssignment()}>
            {sharedBusy ? "Marking your work..." : "Submit for marking"}
          </button>
          {sharedAnswers.filter(isAnswered).length !== sharedAssignment.questions.length && <small> Answer every question to continue.</small>}
        </>
      ) : (
        <>
          <section className="teacher-card">
            <h3>Your result: {sharedResult?.right} of {sharedSubmission.assignment.questions.length}</h3>
            {sharedSubmission.assignment.questions.map((question, index) => (
              <article className={sharedSubmission.marks[question.id]?.correct ? "ok" : "no"} key={question.id}>
                <p><b>{sharedSubmission.marks[question.id]?.correct ? "Correct" : "Keep practising"}:</b> {question.text}</p>
                <p><small>Your response: {responseText(question, sharedSubmission.answers[index]) || "No answer"}</small></p>
                <p><small>{sharedSubmission.marks[question.id]?.feedback}</small></p>
              </article>
            ))}
          </section>
          <section className="teacher-card">
            <h3>Rate this assignment</h3>
            <label className="answer-field"><span>How helpful was it? (1 = not helpful, 5 = very helpful)</span>
              <select value={helpfulness} onChange={(event) => setHelpfulness(Number(event.target.value))}>
                <option value={0}>Choose a rating</option>{[1, 2, 3, 4, 5].map((rating) => <option value={rating} key={rating}>{rating}</option>)}
              </select>
            </label>
            <label className="answer-field"><span>How difficult was it? (1 = easy, 5 = very difficult)</span>
              <select value={difficulty} onChange={(event) => setDifficulty(Number(event.target.value))}>
                <option value={0}>Choose a rating</option>{[1, 2, 3, 4, 5].map((rating) => <option value={rating} key={rating}>{rating}</option>)}
              </select>
            </label>
            <label className="answer-field"><span>What was helpful or confusing? (optional)</span>
              <textarea rows={3} maxLength={500} value={ratingComment} onChange={(event) => setRatingComment(event.target.value)} />
            </label>
            <button className="btn" onClick={() => void createSubmissionLink()}>Create return link for my teacher</button>
          </section>
          {assignmentLink && <section className="teacher-card">
            <label className="answer-field"><span>Your return link</span><textarea rows={3} readOnly value={assignmentLink} onFocus={(event) => event.currentTarget.select()} /></label>
            <button className="ghost" onClick={() => void copyLink(assignmentLink)}>Copy return link</button>
          </section>}
        </>
      )}
      {sharedBusy && <p className="work" role="status"><span className="spin" /> The AI is checking your written answers.</p>}
      {sharedMsg && <p className={sharedBusy ? "work" : "warn"} role="status">{sharedMsg}</p>}
    </>
  ) : null;

  const submissionReviewView = sharedMode === "review" && sharedSubmission && sharedResult ? (
    <>
      <h2>Review student submission</h2>
      <p><b>{ASSIGNMENT_LABEL[sharedSubmission.assignment.kind]}:</b> {sharedSubmission.assignment.title}</p>
      <p><b>Learner:</b> {sharedSubmission.learnerName || "Name not provided"} <b>Submitted:</b> {new Date(sharedSubmission.submittedAt).toLocaleString()}</p>
      <p className="warn"><b>Demo submission:</b> This result came back inside a URL. Anyone with the link can see or change its contents. It is not stored in a shared database.</p>
      <section className="teacher-card">
        <h3>Automatically marked: {sharedResult.right} of {sharedSubmission.assignment.questions.length}</h3>
        {Object.entries(sharedResult.pct).map(([topic, pct]) => <Bar key={topic} label={topic} pct={pct} note={`${sharedResult.by[topic].right} of ${sharedResult.by[topic].total} correct`} />)}
      </section>
      <section className="teacher-card">
        <h3>Learner feedback</h3>
        <p><b>How helpful:</b> {sharedSubmission.helpfulness}/5</p>
        <p><b>How difficult:</b> {sharedSubmission.difficulty}/5</p>
        <p><b>Comment:</b> {sharedSubmission.ratingComment || "No comment provided."}</p>
      </section>
      <h3>Answers and AI feedback</h3>
      {sharedSubmission.assignment.questions.map((question, index) => (
        <article className="q" key={question.id}>
          <p><b>{question.topic}:</b> {question.text}</p>
          <p><b>Learner answered:</b> {responseText(question, sharedSubmission.answers[index]) || "No answer"}</p>
          <p><b>Mark:</b> {sharedSubmission.marks[question.id]?.correct ? "Correct" : "Needs support"}. {sharedSubmission.marks[question.id]?.feedback}</p>
          {!sharedSubmission.marks[question.id]?.correct && <p><b>Expected answer:</b> {answerText(question)}</p>}
        </article>
      ))}
      <section className="teacher-card">
        <h3>Support the topics this learner found difficult</h3>
        <p>Use the score by topic to request a focused, 10-minute reteach plan. The AI suggests possible learning barriers, not confirmed causes.</p>
        <button className="btn" disabled={reviewBusy || status !== "connected"} onClick={() => void buildSubmissionReteach()}>
          {reviewBusy ? "Preparing support plan..." : "Create individual reteach plan"}
        </button>
        {reviewMsg && <p className={reviewBusy ? "work" : "warn"} role="status">{reviewMsg}</p>}
        {reteachPlans.map((plan) => (
          <article className="reteach-card" key={plan.topic}>
            <h4>10-minute reteach: {plan.topic}</h4>
            <p><b>Possible reasons:</b> {plan.likelyReasons.join(" ")}</p>
            <ol>{plan.steps.map((step, index) => <li key={index}><b>{step.minutes} min:</b> {step.teacherAction} <b>Learner:</b> {step.studentAction}</li>)}</ol>
            <p><b>Check understanding:</b> {plan.checkForUnderstanding}</p>
            <p><b>Next:</b> {plan.followUp}</p>
          </article>
        ))}
      </section>
    </>
  ) : sharedMode === "invalid" ? <><h2>Link could not be opened</h2><p className="warn">{sharedMsg}</p></> : null;

  const listHtml = (items: string[]) => `<ul>${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`;
  const lessonHtml = (l: Lesson) =>
    `<h3>${esc(l.title)} (${esc(l.topic)})</h3>` +
    `<p><b>Background:</b> ${esc(l.background)}</p>` +
    `<p><b>Learning objective:</b> ${esc(l.objective)}</p>` +
    `<p><b>Detailed explanation:</b> ${esc(l.explain)}</p>` +
    `<p><b>Key points:</b></p>${listHtml(l.keyPoints)}` +
    `<p><b>Worked example:</b> ${esc(l.example)}</p>` +
    `<p><b>Try it yourself:</b> ${esc(l.practice)}</p>` +
    `<p><b>Practice answer:</b> ${esc(l.practiceAnswer)}</p>` +
    `<p><b>Common mistakes to avoid:</b></p>${listHtml(l.commonMistakes)}` +
    `<p><b>Another way to understand it:</b> ${esc(l.retry)}</p>`;

  const bookHtml = () =>
    `<h1>${APP_NAME}: My Learning Book</h1><h2>${esc(course.title)}</h2>` +
    `<h2>My learning goal</h2><p><b>Subject:</b> ${esc(input)}</p><p><b>What I want to achieve:</b> ${esc(outcome)}</p>` +
    `<h2>My notes and source material</h2>${source.trim() ? `<pre style="white-space:pre-wrap;font-family:inherit">${esc(source)}</pre>` : "<p>No personal notes were supplied.</p>"}` +
    `<h2>Course lessons</h2>` +
    course.lessons.map(lessonHtml).join("") +
    (r ? `<h2>My results</h2><ul>${topics.map((t) => `<li>${esc(t)}: ${latest[t] ?? 0}%</li>`).join("")}</ul>` : "") +
    (taught.length ? `<h2>Explained another way</h2>${taught.map((t) => `<p><b>${esc(t)}:</b> ${esc(lessonOf(t)?.retry || "")}</p>`).join("")}` : "") +
    `<h2>Questions I practised</h2><ol>${[...qs, ...retest].map((q) => `<li>${esc(q.text)}<br><b>Answer: ${esc(answerText(q))}.</b> ${esc(q.why)}</li>`).join("")}</ol>`;

  const packHtml = (c: Course, q: Question[]) =>
    `<h1>${APP_NAME}: Teacher Pack</h1><h2>${esc(c.title)}</h2>` +
    `<h2>Learning goal</h2><p>${esc(tGoal || "The material in my notes")}</p>` +
    `<p><b>Student outcome:</b> ${esc(tOutcome || "Build understanding of the lesson topics")}</p>` +
    `<h2>Source notes</h2>${source.trim() ? `<pre style="white-space:pre-wrap;font-family:inherit">${esc(source)}</pre>` : "<p>No notes supplied.</p>"}` +
    c.lessons.map(lessonHtml).join("") +
    (teacherPlan ? `<h2>Teaching plan (${teacherPlan.durationMinutes} minutes)</h2><p>${esc(teacherPlan.alignment)}</p><ol>${teacherPlan.steps.map((step) => `<li>${step.minutes} min — ${esc(step.stage)}. Teacher: ${esc(step.teacherAction)} Student: ${esc(step.studentAction)}</li>`).join("")}</ol><h2>Teacher coaching</h2>${listHtml(teacherPlan.coaching.tryNext)}` : "") +
    (reteachPlans.length ? `<h2>10-minute reteach plans</h2>${reteachPlans.map((plan) => `<h3>${esc(plan.topic)}</h3><ul>${plan.likelyReasons.map((reason) => `<li>${esc(reason)}</li>`).join("")}</ul><ol>${plan.steps.map((step) => `<li>${step.minutes} min — ${esc(step.teacherAction)} Student: ${esc(step.studentAction)}</li>`).join("")}</ol><p><b>Check:</b> ${esc(plan.checkForUnderstanding)}</p><p><b>Follow-up:</b> ${esc(plan.followUp)}</p>`).join("")}` : "") +
    `<h2>Test and memo</h2><ol>${q.map((x) => `<li>${esc(x.text)}${x.kind === "choice" ? `<br>${x.options.map((o, i) => `${"ABCD"[i]}. ${esc(o)}`).join("<br>")}` : x.kind === "order" ? `<br>Steps: ${x.options.map(esc).join("; ")}` : ""}<br><b>Answer: ${esc(answerText(x))}.</b> ${esc(x.why)}</li>`).join("")}</ol>`;

  const stopSpeech = () => {
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  };

  const changeLesson = (index: number) => {
    recognitionRef.current?.abort();
    setListening(false);
    stopSpeech();
    setTutorReply("");
    setTutorQuestion("");
    setVoiceError("");
    setLessonIndex(index);
  };

  const createAssignmentLink = async () => {
    if (!tCourse || !tQs.length) return;
    setShareMsg("");
    try {
      const assignment: SharedAssignment = {
        version: 1,
        id: crypto.randomUUID(),
        title: tGoal.trim() || tCourse.title,
        kind: assignmentKind,
        instructions: assignmentInstructions.trim(),
        course: tCourse,
        questions: tQs,
        createdAt: new Date().toISOString(),
      };
      const encoded = await encodeShare(assignment);
      if (encoded.length > MAX_SHARE_LENGTH) {
        setShareMsg("This assignment is too large for a reliable share link. Shorten the teacher notes or questions, then create it again.");
        return;
      }
      setAssignmentLink(`${window.location.origin}${window.location.pathname}${window.location.search}#assignment=${encoded}`);
      setShareMsg("Assignment link ready. Anyone with this link can open and complete the assignment.");
    } catch (error) {
      setShareMsg(error instanceof Error ? error.message : "Could not create the assignment link.");
    }
  };

  const copyLink = async (value: string) => {
    const report = (message: string) => sharedMode === "student" ? setSharedMsg(message) : setShareMsg(message);
    try {
      await navigator.clipboard.writeText(value);
      report(sharedMode === "student" ? "Link copied. Send it to your teacher." : "Link copied. Send it to your learners.");
    } catch {
      report("Copy was blocked by the browser. Select the link above and copy it manually.");
    }
  };

  const submitSharedAssignment = async () => {
    if (!sharedAssignment || sharedBusy) return;
    if (sharedAnswers.length !== sharedAssignment.questions.length || sharedAnswers.some((answer) => !isAnswered(answer))) {
      setSharedMsg("Please answer every question before submitting.");
      return;
    }
    setSharedBusy(true);
    setSharedMsg("Checking your answers...");
    try {
      const written = sharedAssignment.questions.flatMap((question, index) => question.kind === "explain" ? [{
        id: question.id,
        text: question.text,
        expectedAnswer: question.expectedAnswer,
        sig: question.sig,
        response: typeof sharedAnswers[index] === "string"
          ? sharedAnswers[index] as string
          : "",
      }] : []);
      const writtenGrades = written.length
        ? await api<{ grades: { id: string; correct: boolean; feedback: string }[] }>("grade", {
          course: sharedAssignment.course,
          responses: written,
        })
        : { grades: [] };
      const feedbackById = new Map(writtenGrades.grades.map((grade) => [grade.id, grade]));
      const marks: Record<string, MarkedResponse> = {};
      sharedAssignment.questions.forEach((question, index) => {
        const answer = sharedAnswers[index];
        if (question.kind === "explain") {
          const grade = feedbackById.get(question.id);
          if (!grade) throw new Error("The AI did not mark every written answer. Please try again.");
          marks[question.id] = { correct: grade.correct, feedback: grade.feedback };
          return;
        }
        const correct = score([question], [answer]).right === 1;
        marks[question.id] = {
          correct,
          feedback: correct
            ? "Correct."
            : `Review this idea. Suggested answer: ${answerText(question)}. ${question.why}`,
        };
      });
      setSharedSubmission({
        version: 1,
        assignment: sharedAssignment,
        learnerName: learnerName.trim().slice(0, 80),
        answers: sharedAnswers,
        marks,
        helpfulness: 0,
        difficulty: 0,
        ratingComment: "",
        submittedAt: new Date().toISOString(),
      });
      setSharedMsg("Your answers have been marked. Review your feedback, then rate the assignment and create a link to return to your teacher.");
    } catch (error) {
      setSharedMsg(error instanceof Error ? error.message : "Could not mark this assignment. Please try again.");
    } finally {
      setSharedBusy(false);
    }
  };

  const createSubmissionLink = async () => {
    if (!sharedSubmission) return;
    if (!helpfulness || !difficulty) {
      setSharedMsg("Please rate how helpful and difficult this assignment was.");
      return;
    }
    try {
      const submission: SharedSubmission = {
        ...sharedSubmission,
        helpfulness,
        difficulty,
        ratingComment: ratingComment.trim().slice(0, 500),
      };
      const encoded = await encodeShare(submission);
      if (encoded.length > MAX_SHARE_LENGTH) {
        setSharedMsg("This response is too large for a reliable return link. Shorten your written answers and try again.");
        return;
      }
      const link = `${window.location.origin}${window.location.pathname}${window.location.search}#submission=${encoded}`;
      setSharedSubmission(submission);
      setSharedMsg("Your return link is ready. Copy it and send it to your teacher so they can review your work.");
      setAssignmentLink(link);
    } catch (error) {
      setSharedMsg(error instanceof Error ? error.message : "Could not create your return link.");
    }
  };

  const buildSubmissionReteach = async () => {
    if (!sharedSubmission || reviewBusy) return;
    setReviewBusy(true);
    setReviewMsg("");
    setReteachPlans([]);
    try {
      const byTopic: Record<string, { assessed: number; met: number }> = {};
      sharedSubmission.assignment.questions.forEach((question) => {
        if (!byTopic[question.topic]) byTopic[question.topic] = { assessed: 0, met: 0 };
        byTopic[question.topic].assessed += 1;
        if (sharedSubmission.marks[question.id]?.correct) byTopic[question.topic].met += 1;
      });
      const { plans, message } = await api<{ plans: TopicReteachPlan[]; message: string }>("reteachPlan", {
        course: sharedSubmission.assignment.course,
        goal: sharedSubmission.assignment.title,
        results: Object.entries(byTopic).map(([topic, counts]) => ({ topic, ...counts })),
      });
      setReteachPlans(plans);
      setReviewMsg(message || (plans.length
        ? "Review these possible learning barriers and the focused 10-minute reteach suggestions."
        : "No topics fell below the reteach threshold for this submission."));
    } catch (error) {
      setReviewMsg(error instanceof Error ? error.message : "Could not prepare teacher support suggestions.");
    } finally {
      setReviewBusy(false);
    }
  };

  const speakText = (text: string) => {
    setVoiceError("");
    if (!("speechSynthesis" in window)) {
      setVoiceError("Spoken audio is not available in this browser. You can still read the lesson and tutor replies.");
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = document.documentElement.lang || navigator.language || "en-US";
    utterance.rate = 0.95;
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = (event) => {
      setSpeaking(false);
      if (event.error !== "canceled" && event.error !== "interrupted") {
        setVoiceError("The voice could not play. Try again or check your device audio settings.");
      }
    };
    window.speechSynthesis.speak(utterance);
  };

  const currentLessonSpeech = currentLesson
    ? `Background. ${currentLesson.background} Learning objective. ${currentLesson.objective} Lesson. ${currentLesson.explain} Key points. ${currentLesson.keyPoints.join(". ")} Worked example. ${currentLesson.example} Practice activity. ${currentLesson.practice} Common mistakes to avoid. ${currentLesson.commonMistakes.join(". ")}`
    : "";

  const askTutor = async (question = tutorQuestion) => {
    const prompt = question.trim();
    if (!prompt || !currentLesson || tutorBusy) return;
    setTutorQuestion(prompt);
    setTutorBusy(true);
    setTutorReply("");
    setVoiceError("");
    stopSpeech();
    try {
      const { reply } = await api<{ reply: string }>("tutor", {
        course, topic: currentLesson.topic, question: prompt, level, source,
      });
      setTutorReply(reply);
      speakText(reply);
    } catch (err: any) {
      setVoiceError(err?.message || "The voice tutor could not answer. Please try again.");
    } finally {
      setTutorBusy(false);
    }
  };

  const startListening = () => {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      setVoiceError("Voice questions are not supported in this browser. Type your question instead, or try a current version of Chrome or Edge.");
      return;
    }
    recognitionRef.current?.abort();
    stopSpeech();
    setVoiceError("");
    const recognition = new Recognition();
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      const spoken = event.results[event.resultIndex]?.[0]?.transcript?.trim();
      if (spoken) {
        recognition.stop();
        setListening(false);
        setTutorQuestion(spoken);
        void askTutor(spoken);
      }
    };
    recognition.onerror = (event) => {
      setListening(false);
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setVoiceError("Microphone access is blocked. Allow microphone access in your browser settings, or type your question.");
      } else if (event.error !== "aborted" && event.error !== "no-speech") {
        setVoiceError("I could not hear that clearly. Try again or type your question.");
      }
    };
    recognition.onend = () => {
      setListening(false);
      if (recognitionRef.current === recognition) recognitionRef.current = null;
    };
    recognitionRef.current = recognition;
    setListening(true);
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setListening(false);
      setVoiceError("The microphone could not start. Check browser microphone permission and try again.");
    }
  };

  const stopListening = () => {
    recognitionRef.current?.stop();
    setListening(false);
  };

  /* ---------- teacher: plan and assess a lesson from notes ---------- */
  const teacherMake = async () => {
    setTMsg("");
    if (status !== "connected") { setTMsg("Groq AI is not connected. Add GROQ_API_KEY to .env.local and restart the app."); return; }
    if (source.trim().length < 50) { setTMsg("Add your memo or notes first (at least a few sentences)."); return; }
    setTBusy(true);
    setTCourse(null); setTQs([]); setTeacherPlan(null); setReteachPlans([]); setClassMsg("");
    try {
      const goal = tGoal.trim() || "the material in my notes";
      setTMsg("Reading your memo and writing lessons…");
      const { course: c } = await api<{ course: Course }>("course", { goal, outcome: tOutcome, level, source });
      setTMsg("Writing a test from your lesson…");
      const d = await api<{ questions: Question[] }>("draft", { course: c, level, source });
      setTMsg("Checker is reviewing every question…");
      const v = await api<{ questions: Question[]; findings: Finding[] }>("review", { course: c, level, source, questions: d.questions });
      setTMsg("Creating your timed teaching plan and teacher coaching…");
      const { plan } = await api<{ plan: TeacherPlan }>("teacherPlan", {
        course: c, goal, outcome: tOutcome, level, source, durationMinutes: lessonMinutes,
      });
      setTCourse(c); setTQs(v.questions); setTeacherPlan(plan);
      setClassCounts(Object.fromEntries(c.lessons.map((lesson) => [lesson.topic, { assessed: "", met: "" }])));
      const changed = v.findings.filter((f) => f.action !== "approved").length;
      setTMsg(`Ready. Your ${lessonMinutes}-minute lesson plan, teacher coaching, and ${v.questions.length}-question test are prepared${changed ? `; ${changed} question(s) were fixed or removed by the checker` : "; all questions passed the checker"}.`);
    } catch (err: any) {
      setTMsg(err?.message || "Something went wrong. Please try again.");
    } finally { setTBusy(false); }
  };

  const analyzeClass = async () => {
    if (!tCourse) return;
    setClassMsg("");
    const results: { topic: string; assessed: number; met: number }[] = [];
    for (const lesson of tCourse.lessons) {
      const counts = classCounts[lesson.topic];
      if (!counts?.assessed.trim() && !counts?.met.trim()) continue;
      if (!/^\d+$/.test(counts.assessed) || !/^\d+$/.test(counts.met)) {
        setClassMsg(`Enter whole-number class counts for ${lesson.topic}, or leave both boxes empty.`);
        return;
      }
      const assessed = Number(counts.assessed);
      const met = Number(counts.met);
      if (assessed < 1 || met > assessed) {
        setClassMsg(`${lesson.topic}: students meeting the goal must be between 0 and the number assessed.`);
        return;
      }
      results.push({ topic: lesson.topic, assessed, met });
    }
    if (!results.length) {
      setClassMsg("Enter the number assessed and meeting the goal for at least one topic.");
      return;
    }
    setClassBusy(true);
    setReteachPlans([]);
    try {
      const result = await api<{ plans: TopicReteachPlan[]; message: string }>("reteachPlan", {
        course: tCourse, goal: tGoal, level, source, results,
      });
      setReteachPlans(result.plans);
      setClassMsg(result.message || "Results analyzed. Review the reteach suggestions below.");
    } catch (err: any) {
      setClassMsg(err?.message || "Could not analyze these results. Please try again.");
    } finally { setClassBusy(false); }
  };

  const working = phase === "plan" || phase === "making" || phase === "marking";
  const answered = answers.filter(isAnswered).length;
  const rAnswered = rAns.filter(isAnswered).length;
  const classResults = tCourse?.lessons.flatMap((lesson) => {
    const counts = classCounts[lesson.topic];
    if (!counts?.assessed || !/^\d+$/.test(counts.assessed) || !/^\d+$/.test(counts.met)) return [];
    const assessed = Number(counts.assessed);
    const met = Number(counts.met);
    if (!assessed || met > assessed) return [];
    return [{ topic: lesson.topic, assessed, met, percent: Math.round((100 * met) / assessed) }];
  }) || [];

  const learner = (
    <>
      {phase === "home" && (
        <>
          <h2>What do you want to learn?</h2>
          <p>Choose a subject and tell me what you want to be able to do. I will build a detailed course around your goal.</p>
          <div className="ask">
            <input aria-label="Subject you want to learn" placeholder="Subject, for example: English" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
            <input aria-label="What you want to achieve" placeholder="What do you want to achieve? For example: speak confidently" value={outcome} onChange={(e) => setOutcome(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
            <select aria-label="Your level" value={level} onChange={(e) => setLevel(e.target.value as Level)}>{LEVELS.map((l) => <option key={l}>{l}</option>)}</select>
            <button className="btn" disabled={!input.trim() || !outcome.trim() || status !== "connected"} onClick={go}>Start learning</button>
          </div>
          <p><b>English goal examples:</b></p>
          <p className="chips">
            {[
              ["Speak confidently", "Speak English confidently in everyday conversations."],
              ["Read fluently", "Read English fluently and understand what I read."],
              ["Write clearly", "Write clear English sentences and short paragraphs."],
              ["Improve grammar", "Use English grammar and vocabulary correctly."],
            ].map(([label, target]) => (
              <button key={label} className="chip" onClick={() => { setInput("English"); setOutcome(target); }}>{label}</button>
            ))}
          </p>
          <p><b>Other subjects:</b></p>
          <p className="chips">
            {[
              ["Fractions", "Understand fractions and solve everyday fraction problems."],
              ["Solar inverters", "Understand how a solar inverter works in a home system."],
              ["Budgeting", "Create and follow a simple monthly budget."],
            ].map(([subject, target]) => (
              <button key={subject} className="chip" onClick={() => { setInput(subject); setOutcome(target); }}>{subject}</button>
            ))}
          </p>
          <SourceBox source={source} setSource={setSource} id="src-learner" />
          {history.length > 0 && (
            <>
              <h3>Your recent learning</h3>
              <ul className="hist">
                {history.slice(0, 3).map((h) => (
                  <li key={h.id}><b>{h.title}</b> <small>{new Date(h.date).toLocaleDateString()} · first test {h.first}</small>
                    <div>{Object.entries(h.topics).map(([t, p]) => <span key={t} className={"tag" + (p < 60 ? " low" : "")}>{t} {p}%</span>)}</div>
                  </li>
                ))}
              </ul>
            </>
          )}
          <h3>How it works</h3>
          <ol className="steps">{STEPS.map(([a, b]) => <li key={a}><b>{a}.</b> {b}</li>)}</ol>
        </>
      )}
      {working && <p className="work" role="status"><span className="spin" /> {phase === "plan" ? "Writing your lessons…" : phase === "making" ? "Writing and checking your test…" : "Marking your answers…"} This can take 10 to 20 seconds. Follow along on the right.</p>}
      {error && (
        <div className="err" role="alert">
          <p><b>That did not work.</b> {error}</p>
          {retry.current && <button className="btn" onClick={() => retry.current?.()}>Try again</button>}
        </div>
      )}
      {note && phase !== "home" && <p className="warn">{note}</p>}
      {phase === "learn" && (
        <>
          <h2>Your lessons: {course.title}</h2>
          {currentLesson && (
            <>
              <p className="lesson-progress">Lesson {lessonIndex + 1} of {course.lessons.length} <span>·</span> Topic: <b>{currentLesson.topic}</b></p>
              <section key={currentLesson.topic} className="block">
                <h3>{currentLesson.title}</h3>
                <h4>Background</h4>
                <p>{currentLesson.background}</p>
                <p><b>By the end of this lesson:</b> {currentLesson.objective}</p>
                <p>{currentLesson.explain}</p>
                <h4>Key points</h4>
                <ul>{currentLesson.keyPoints.map((point, i) => <li key={i}>{point}</li>)}</ul>
                <h4>Worked example</h4>
                <p><mark>{currentLesson.example}</mark></p>
                <h4>Try it yourself</h4>
                <p>{currentLesson.practice}</p>
                <details>
                  <summary>Show the practice answer</summary>
                  <p>{currentLesson.practiceAnswer}</p>
                </details>
                <h4>Common mistakes to avoid</h4>
                <ul>{currentLesson.commonMistakes.map((mistake, i) => <li key={i}>{mistake}</li>)}</ul>
                <details>
                  <summary>Explain it another way</summary>
                  <p>{currentLesson.retry}</p>
                </details>
                <div className="voice-controls" aria-label="Lesson audio controls">
                  <button className="btn" onClick={() => speakText(currentLessonSpeech)}>{speaking ? "Replay lesson aloud" : "Read lesson aloud"}</button>
                  {speaking && <button className="ghost" onClick={stopSpeech}>Stop audio</button>}
                  <small>Uses your browser&apos;s built-in voice. Audio is not recorded.</small>
                </div>
              </section>
              <section className="teacher-card voice-tutor" aria-labelledby="voice-tutor-title">
                <h3 id="voice-tutor-title">Ask your AI voice tutor</h3>
                <p>Ask a question about this lesson. You can speak or type; the tutor answers using this lesson and relevant notes.</p>
                <label htmlFor="tutor-question"><b>Your question</b></label>
                <textarea id="tutor-question" rows={3} maxLength={1000} placeholder={`Ask about ${currentLesson.topic}…`} value={tutorQuestion} onChange={(event) => setTutorQuestion(event.target.value)} />
                <div className="voice-controls">
                  <button className="btn" disabled={tutorBusy || !tutorQuestion.trim()} onClick={() => void askTutor()}>{tutorBusy ? "Thinking…" : "Ask the tutor"}</button>
                  {listening
                    ? <button className="ghost" onClick={stopListening}>Stop listening</button>
                    : <button className="ghost" disabled={tutorBusy} onClick={startListening}>Ask by voice</button>}
                  {tutorReply && <button className="ghost" onClick={() => speakText(tutorReply)}>Read answer aloud</button>}
                </div>
                {listening && <p className="work" role="status">Listening… Speak your question, then I&apos;ll answer aloud.</p>}
                {tutorBusy && <p className="work" role="status"><span className="spin" /> Preparing a lesson-based answer…</p>}
                {voiceError && <p className="warn" role="alert">{voiceError}</p>}
                {tutorReply && <div className="tutor-reply" aria-live="polite"><b>Tutor:</b> {tutorReply}</div>}
              </section>
              <div className="lesson-nav">
                <button className="ghost" disabled={lessonIndex === 0} onClick={() => changeLesson(lessonIndex - 1)}>Previous lesson</button>
                {lastLesson
                  ? <button className="btn" disabled={busy} onClick={() => makeTest()}>I have read them. Test me.</button>
                  : <button className="btn" onClick={() => changeLesson(lessonIndex + 1)}>Next lesson</button>}
              </div>
            </>
          )}
        </>
      )}
      {phase === "test" && (
        <>
          <h2>Your test</h2>
          <p><small>Answer in the format each question asks for. Written explanations are checked for meaning. {answered} of {qs.length} answered.</small></p>
          {findings.some((f) => f.action !== "approved") && <p className="note-ok">✓ A checker reviewed these questions and fixed {findings.filter((f) => f.action !== "approved").length}.</p>}
          <SelfCheckCard findings={findings} />
          <Quiz qs={qs} vals={answers} onPick={pickA} />
          <button className="btn" disabled={answered < qs.length} onClick={() => submit(answers)}>Submit my answers</button>
          {answered < qs.length && <small> Answer every question to continue.</small>}
        </>
      )}
      {phase === "reteach" && r && (
        <>
          <h2>First result: {r.right} of {qs.length}</h2>
          {qs.map((q, i) => (
            <p key={q.id} className={score([q], [answers[i]], [grades[i]]).right === 1 ? "ok" : "no"}>
              {score([q], [answers[i]], [grades[i]]).right === 1 ? "✓ Correct" : "✗ Not yet"}: {q.text}
              <br /><small>Your answer: {responseText(q, answers[i]) || "No answer"}</small>
              {score([q], [answers[i]], [grades[i]]).right !== 1 && <><br /><small>Suggested answer: <b>{answerText(q)}</b>. {q.why}</small></>}
            </p>
          ))}
          <h2>Let us try that another way</h2>
          {taught.map((t) => {
            const l = lessonOf(t)!;
            return <section key={t} className="block"><h3>{l.title}</h3><p>{l.retry}</p></section>;
          })}
          <button className="btn" onClick={() => setPhase("retest")}>Retest me on {taught.join(", ")}</button>
        </>
      )}
      {phase === "retest" && (
        <>
          <h2>Retest</h2>
          <p><small>{rAnswered} of {retest.length} answered.</small></p>
          <Quiz qs={retest} vals={rAns} onPick={pickR} />
          <button className="btn" disabled={rAnswered < retest.length} onClick={() => submitRetest(rAns, retest)}>Submit my answers</button>
        </>
      )}
      {phase === "report" && r && (
        <>
          <h2>Your result</h2>
          <p>You got {r.right} of {qs.length} on the first test{taught.length ? `, then learned ${taught.join(", ")} a second way and retested` : ""}.</p>
          <ProofCard topics={topics} first={r.pct} latest={latest} retested={taught.length > 0} />
          {topics.map((t) => <Bar key={t} label={t} pct={latest[t] ?? 0} note={taught.includes(t) ? "re-taught" : undefined} />)}
          {stillWeak.length === 0 ? <p className="note-ok">✓ You now have every topic. Well done.</p> : <p className="warn">Still shaky on {stillWeak.join(", ")}. Practise again with fresh questions.</p>}
          <p className="actions">
            {stillWeak.length > 0 && <button className="btn" disabled={busy} onClick={() => practise(stillWeak)}>Practise {stillWeak.join(", ")} again</button>}
            <button className="btn" disabled={busy || status !== "connected"} onClick={continueCourse}>Continue learning this course</button>
            <button className="btn" onClick={() => void downloadPdf("my-learning-book.pdf", `${APP_NAME}: My Learning Book`, bookHtml())}>Download my learning book (PDF)</button>
            <button className="btn" onClick={() => { download("my-learning-book.doc", bookHtml()); setFileNote("Word file downloaded."); }}>Download my learning book (Word)</button>
            <button className="ghost" onClick={() => setTab("teacher")}>See the teacher view</button>
            <button className="ghost" onClick={reset}>Learn something else</button>
          </p>
          {fileNote && <p className="note-ok" role="status">{fileNote}</p>}
        </>
      )}
    </>
  );

  const teacher = (
    <>
      <h2>Teacher planning room</h2>
      <p>Turn your lesson notes into a teachable plan, a student learning journey, a checked test, and friendly coaching for your next lesson.</p>
      <SourceBox source={source} setSource={setSource} id="src-teacher" />
      <div className="ask">
        <input aria-label="Subject or topic" placeholder="Subject or topic, e.g. Geography: rivers" value={tGoal} onChange={(e) => setTGoal(e.target.value)} />
        <input aria-label="Student learning goal" placeholder="What should learners understand or do?" value={tOutcome} onChange={(e) => setTOutcome(e.target.value)} />
        <select aria-label="Level" value={level} onChange={(e) => setLevel(e.target.value as Level)}>{LEVELS.map((l) => <option key={l}>{l}</option>)}</select>
        <label className="duration-field">Lesson length
          <select aria-label="Lesson length in minutes" value={lessonMinutes} onChange={(e) => setLessonMinutes(Number(e.target.value))}>
            {[30, 40, 50, 60, 75, 90].map((minutes) => <option key={minutes} value={minutes}>{minutes} min</option>)}
          </select>
        </label>
        <button className="btn" disabled={tBusy || status !== "connected"} onClick={teacherMake}>{tBusy ? "Preparing…" : "Plan lesson + create test"}</button>
      </div>
      <p><small>The AI uses your lesson notes as its teaching source. It retrieves passages that match the topic and goal, and uses the course lessons to align the plan and test. No student names are sent.</small></p>
      {tMsg && <p className={tBusy ? "work" : "warn"} role="status">{tBusy && <span className="spin" />} {tMsg}</p>}
      {teacherPlan && (
        <section className="teacher-card">
          <h3>Your {teacherPlan.durationMinutes}-minute lesson plan</h3>
          <p><b>Learning goal:</b> {teacherPlan.learningGoal}</p>
          <p><b>How it aligns with your lesson:</b> {teacherPlan.alignment}</p>
          <h4>Teaching and student journey</h4>
          <ol className="plan-steps">{teacherPlan.steps.map((step, index) => (
            <li key={`${step.stage}-${index}`}>
              <b>{step.minutes} min · {step.stage}</b>
              <p><b>Teacher:</b> {step.teacherAction}</p>
              <p><b>Students:</b> {step.studentAction}</p>
            </li>
          ))}</ol>
          <h4>Materials</h4>
          <ul>{teacherPlan.materials.map((item, index) => <li key={index}>{item}</li>)}</ul>
          <h4>Quick checks for understanding</h4>
          <ul>{teacherPlan.checksForUnderstanding.map((item, index) => <li key={index}>{item}</li>)}</ul>
          <h4>Ways to support different learners</h4>
          <ul>{teacherPlan.supportStrategies.map((item, index) => <li key={index}>{item}</li>)}</ul>
          <h4>Friendly teacher coaching</h4>
          <p><b>Keep doing:</b></p>
          <ul>{teacherPlan.coaching.keepDoing.map((item, index) => <li key={index}>{item}</li>)}</ul>
          <p><b>Try next:</b></p>
          <ul>{teacherPlan.coaching.tryNext.map((item, index) => <li key={index}>{item}</li>)}</ul>
          <p><b>Reflect after class:</b></p>
          <ul>{teacherPlan.coaching.reflectionQuestions.map((item, index) => <li key={index}>{item}</li>)}</ul>
        </section>
      )}
      {tCourse && tQs.length > 0 && (
        <>
          <h3>Student test: {tCourse.title}</h3>
          <ol>{tQs.map((q) => <li key={q.id}>{q.text}{q.kind === "choice" && <ul>{q.options.map((option, index) => <li key={option}>{String.fromCharCode(65 + index)}. {option}</li>)}</ul>}{q.kind === "order" && <p>Steps: {q.options.join("; ")}</p>}<br /><small>Answer: {answerText(q)}. {q.why}</small></li>)}</ol>
          <p className="note-ok">Want learners to do this online? Go <b>Home → Teacher → Tests and classwork</b>. You get a short code, the answers stay safely on the server, and you can edit the questions.</p>
          <p className="actions">
            <button className="btn" onClick={() => void downloadPdf("teacher-pack.pdf", `${APP_NAME}: Teacher Pack`, packHtml(tCourse, tQs))}>Download teacher pack (PDF)</button>
            <button className="btn" onClick={() => { download("teacher-pack.doc", packHtml(tCourse, tQs)); setFileNote("Word file downloaded."); }}>Download teacher pack (Word)</button>
          </p>
          {fileNote && <p className="note-ok" role="status">{fileNote}</p>}
          <section className="teacher-card">
            <h3>Class results and reteach plan</h3>
            <p>After marking the class test, enter how many learners were assessed and how many met the goal for each topic. Topics below 70% get a focused 10-minute reteach plan.</p>
            <p className="warn"><b>Local for now:</b> enter class totals yourself. They are analyzed for this session and are not saved or shared with students yet. Add Supabase later for student links, saved classes, and automatic results.</p>
            <div className="class-count-head"><b>Topic</b><b>Assessed</b><b>Met the goal</b></div>
            {tCourse.lessons.map((lesson) => (
              <div className="class-count-row" key={lesson.topic}>
                <label htmlFor={`assessed-${lesson.topic}`}>{lesson.topic}</label>
                <input id={`assessed-${lesson.topic}`} aria-label={`${lesson.topic}: students assessed`} type="number" min="0" step="1" value={classCounts[lesson.topic]?.assessed || ""} onChange={(e) => setClassCounts((current) => ({ ...current, [lesson.topic]: { ...current[lesson.topic], assessed: e.target.value, met: current[lesson.topic]?.met || "" } }))} />
                <input aria-label={`${lesson.topic}: students who met the goal`} type="number" min="0" step="1" value={classCounts[lesson.topic]?.met || ""} onChange={(e) => setClassCounts((current) => ({ ...current, [lesson.topic]: { ...current[lesson.topic], assessed: current[lesson.topic]?.assessed || "", met: e.target.value } }))} />
              </div>
            ))}
            <button className="ghost" onClick={() => setClassCounts(sampleClassCounts(tCourse.lessons.map((lesson) => lesson.topic)))}>Fill with sample class results (demo)</button>{" "}
            <button className="btn" disabled={classBusy || status !== "connected"} onClick={analyzeClass}>{classBusy ? "Building reteach plan…" : "Analyze results and make reteach plan"}</button>
            {classMsg && <p className={classBusy ? "work" : "warn"} role="status">{classBusy && <span className="spin" />} {classMsg}</p>}
            <TeacherInsight results={classResults} />
            {classResults.length > 0 && (
              <>
                <h4>Class performance</h4>
                {classResults.map((result) => <Bar key={result.topic} label={result.topic} pct={result.percent} note={`${result.met} of ${result.assessed} learners met the goal`} />)}
              </>
            )}
            {reteachPlans.map((plan) => (
              <article className="reteach-card" key={plan.topic}>
                <h4>10-minute fix: {plan.topic}</h4>
                <p><b>Why learners may have struggled:</b></p>
                <ul>{plan.likelyReasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
                <ol className="plan-steps">{plan.steps.map((step, index) => (
                  <li key={index}><b>{step.minutes} min</b><p><b>Teacher:</b> {step.teacherAction}</p><p><b>Students:</b> {step.studentAction}</p></li>
                ))}</ol>
                <p><b>Check understanding:</b> {plan.checkForUnderstanding}</p>
                <p><b>If they still need help:</b> {plan.followUp}</p>
              </article>
            ))}
          </section>
        </>
      )}
      <h3>Class report</h3>
      <p><small>Previous learner attempts recorded on this browser. These are not shared class results; use the class assessment above for teacher-entered class totals.</small></p>
      {history.length > 0 && (
        <>
          <h3>Results saved on this device</h3>
          <ul className="hist">{history.slice(0, 8).map((h) => (
            <li key={h.id}><b>{h.title}</b> <small>{new Date(h.date).toLocaleDateString()} · first test {h.first}</small>
              <div>{Object.entries(h.topics).map(([t, p]) => <span key={t} className={"tag" + (p < 60 ? " low" : "")}>{t} {p}%</span>)}</div></li>
          ))}</ul>
          <button className="link" onClick={() => { localStorage.removeItem(HKEY); setHistory([]); }}>Clear saved results</button>
        </>
      )}
    </>
  );

  const showTrace = tab === "learner" && phase !== "home";

  return (
    <div className="app" ref={top}>
      <header className="top">
        <div>
          <h1>{APP_NAME}</h1>
          <p>{TAGLINE}</p>
        </div>
        <nav>
          {status !== "checking" && <span className={"pill " + status} title={status === "connected" ? "Groq AI is connected" : "Add GROQ_API_KEY to connect Groq"}>{status === "connected" ? "● Groq connected" : "○ Groq not connected"}</span>}
          {embedded
            ? onHome && <button className="ghost" onClick={onHome}>← Home</button>
            : <>
              <button className={"tab" + (tab === "learner" ? " on" : "")} onClick={() => setTab("learner")}>Learner</button>
              <button className={"tab" + (tab === "teacher" ? " on" : "")} onClick={() => setTab("teacher")}>Teacher</button>
            </>}
          {sharedMode
            ? <button className="ghost" onClick={closeShared}>Close shared link</button>
            : phase !== "home" && <button className="ghost" onClick={reset}>Start over</button>}
        </nav>
      </header>
      <WaitBanner />
      {status === "unavailable" && <p className="warn"><b>Groq AI is not connected.</b> Add your <code>GROQ_API_KEY</code> to <code>.env.local</code>, then restart the app.</p>}
      {tab === "learner" && phase !== "home" && !sharedMode && <Stepper phase={phase} />}
      <div className={"shell" + (showTrace ? " two" : "")}>
        <div className="cover" aria-hidden="true" />
        <main className="paper" key={`${tab}-${phase}-${sharedMode || ""}`}>
          {sharedMode === "student" ? sharedAssignmentView : sharedMode === "review" || sharedMode === "invalid"
            ? submissionReviewView
            : tab === "teacher" ? teacher : learner}
        </main>
        {showTrace && (
          <aside className="trace" aria-label="Agent working-out">
            <h3>What the AI is doing</h3>
            <p><small>Every step is shown, so you can see how it checks its own work.</small></p>
            <div className="log" ref={box} aria-live="polite">
              {trace.map((t) => (
                <p key={t.id} className={"ln " + t.kind}><b>{LABEL[t.kind]}</b> {t.text}</p>
              ))}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
