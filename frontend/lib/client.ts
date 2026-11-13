/* Browser-side helpers shared by the new screens. Nothing here runs on the server. */
import type { Finding, Question } from "./agent";
import { batchPlan } from "./sizing";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const announce = (seconds: number) => { try { window.dispatchEvent(new CustomEvent("prooflearn-wait", { detail: seconds })); } catch { /* ignore */ } };

/** Sends JSON to our server. If the AI says "try again in N seconds" (N up to 90), this waits, shows a countdown
    (see WaitBanner) and tries again by itself, up to 3 times. Anything else becomes a plain error message. */
export async function api<T>(path: string, body: object): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch {
      throw new Error("I could not reach the server. Check your internet and try again.");
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data as T;
    const wait = Number(data.retryAfter);
    if (res.status === 429 && wait > 0 && wait <= 90 && attempt < 4) {
      for (let s = Math.ceil(wait) + 1; s > 0; s--) { announce(s); await sleep(1000); }
      announce(0);
      continue;
    }
    throw new Error(data.error || "Something went wrong. Please try again.");
  }
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ---------- reading a file the person chose ---------- */
export const NOTE_MAX = 20000;
export async function readFileText(f: File, onStatus: (message: string) => void = () => undefined): Promise<string> {
  if (/\.pdf$/i.test(f.name)) {
    // Small PDFs: the server reads the text layer (fast). If it cannot (a scan, or text turned into pictures,
    // or an odd file), or the file is big, we read it inside the browser instead (text first, then OCR).
    if (f.size <= 4_000_000) {
      try { return await viaServer(f); } catch (e: any) { if (!e.fallback) throw e; }
    }
    const { readPdfInBrowser } = await import("./ocr");
    return readPdfInBrowser(f, onStatus);
  }
  if (/\.docx$/i.test(f.name)) { try { return await viaServer(f); } catch (e: any) { throw new Error(e.message); } }
  if (/\.(txt|md|csv)$/i.test(f.name)) {
    if (f.size > 2_000_000) throw new Error("That file is too large (2 MB maximum for text files).");
    return f.text();
  }
  throw new Error("I can read PDF, Word (.docx), .txt, .md and .csv files. For anything else, copy the text and paste it in.");
}

async function viaServer(f: File): Promise<string> {
  const body = new FormData();
  body.append("file", f);
  let res: Response;
  try { res = await fetch("/api/extract", { method: "POST", body }); }
  catch { throw Object.assign(new Error("I could not reach the server to read that file."), { fallback: true }); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "I could not read that file."), { fallback: ["no_text", "parse", "damaged"].includes(data.code) });
  return data.text as string;
}

/* ---------- saving things on this device ---------- */
export type LocalNote = {
  id: string; title: string; body: string; updatedAt: number;
  /** set when a teacher has shared this note: the share code and the secret teacher key */
  shared?: { code: string; key: string };
};
const read = <T,>(key: string, fallback: T): T => { try { return JSON.parse(localStorage.getItem(key) || "") as T; } catch { return fallback; } };
const save = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };

export type Role = "learner" | "teacher";
export const loadNotes = (role: Role): LocalNote[] => read<LocalNote[]>(`prooflearn.notes.${role}`, []);
export const saveNotes = (role: Role, notes: LocalNote[]) => save(`prooflearn.notes.${role}`, notes.slice(0, 200));
export const newNoteId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export type SavedWork = { code: string; key: string; title: string; kind: string };
export const loadWork = (): SavedWork[] => read<SavedWork[]>("prooflearn.work.teacher", []);
export const saveWork = (w: SavedWork[]) => save("prooflearn.work.teacher", w.slice(0, 100));

export const getPasscode = () => { try { return sessionStorage.getItem("prooflearn.passcode") || ""; } catch { return ""; } };
export const setPasscode = (v: string) => { try { sessionStorage.setItem("prooflearn.passcode", v); } catch { /* ignore */ } };

/* ---------- download a note: Word (.doc) or a tidy PDF. Both are built from the same structure (see lib/pdf.ts) ---------- */
export { downloadNotePdf } from "./pdf";
export { downloadNoteWord as downloadWord } from "./pdf";

/* ---------- a question as the learner sees it (no answers) -> the shape the Quiz widget expects ---------- */
export type PublicQ = { id: string; topic: string; kind: "choice" | "explain" | "order"; text: string; options: string[] };
export const asQuiz = (q: PublicQ): Question =>
  ({ ...q, why: "", answer: q.kind === "order" ? [] : q.kind === "choice" ? -1 : -1, expectedAnswer: "" }) as unknown as Question;

export function addLocalNote(role: Role, title: string, body: string): LocalNote {
  const n: LocalNote = { id: newNoteId(), title: title.slice(0, 120) || "Untitled note", body: body.slice(0, NOTE_MAX), updatedAt: Date.now() };
  saveNotes(role, [n, ...loadNotes(role)]);
  return n;
}


/* ---------- write a test of any size (3 to 100 questions) ---------- */
export type GenResult = { questions: Question[]; findings: Finding[]; checked: boolean; note: string };
export type Cancel = { stop: boolean };

/** Writes the questions in batches of up to 10. Each batch uses its own part of the note, so the
    whole note is covered and nothing repeats. If something goes wrong half way, what is already
    written is kept and `note` explains. Only throws when nothing could be written. */
export async function generateQuestions(o: {
  notes: string; total: number; mix: "mixed" | "choice" | "written"; level: string; focus: string;
  forTeacher?: boolean; passcode?: string; onProgress?: (done: number, total: number) => void; cancel?: Cancel;
}): Promise<GenResult> {
  const plan = batchPlan(o.total);
  const all: Question[] = [], findings: Finding[] = [];
  let checked = true, note = "";
  const seen = new Set<string>();
  for (let i = 0; i < plan.length; i++) {
    if (o.cancel?.stop) { note = "You stopped it early."; break; }
    o.onProgress?.(all.length, o.total);
    try {
      const r = await api<{ questions: Question[]; findings: Finding[]; checked: boolean }>("/api/study", {
        action: "test", notes: o.notes, focus: o.focus, count: plan[i], part: i, parts: plan.length, idPrefix: `p${i}_`,
        avoid: all.slice(-60).map((q) => q.text.slice(0, 150)), mix: o.mix, level: o.level,
        forTeacher: !!o.forTeacher, passcode: o.passcode || "",
      });
      for (const q of r.questions) {
        const key = q.text.toLowerCase().replace(/\W+/g, " ").trim();
        if (!seen.has(key)) { seen.add(key); all.push(q); }
      }
      findings.push(...r.findings);
      checked = checked && r.checked;
    } catch (e: any) {
      if (!all.length) throw e;
      note = `I wrote ${all.length} of the ${o.total} questions, then hit a problem: ${e.message}`;
      break;
    }
  }
  o.onProgress?.(all.length, o.total);
  if (!all.length) throw new Error("I could not make questions from that text. Try adding more detail.");
  if (!note && all.length < o.total * 0.8) note = `I made ${all.length} of the ${o.total} you asked for. The note may not have enough different facts for more. You can press the button again to add more.`;
  return { questions: all, findings, checked, note };
}
