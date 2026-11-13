/* How many questions suit a note? Short note = few questions, long note = many.
   Used by the screens (to suggest and to limit) and checked again on the server. */

export const MAX_QUESTIONS = 100;
export const BATCH = 10; // one AI request writes at most this many questions

export const wordsOf = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);

/** The number we suggest ("Automatic"). Under 10 for short notes, up to 100 for very long ones. */
export function suggestCount(chars: number): number {
  if (chars < 400) return 3;
  if (chars < 800) return 5;
  if (chars < 1500) return 7;
  if (chars < 2500) return 9;
  return Math.min(MAX_QUESTIONS, 9 + Math.round((chars - 2500) / 190));
}

/** The most questions a note can fairly support (about one per 150 characters). */
export const maxCount = (chars: number) => Math.max(3, Math.min(MAX_QUESTIONS, Math.floor(chars / 150)));

const PRESETS = [3, 5, 8, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100];
export const countOptions = (chars: number) => PRESETS.filter((n) => n <= maxCount(chars));

/** Split a total into equal-ish batches of at most BATCH questions: 25 -> [9, 8, 8]. */
export function batchPlan(total: number): number[] {
  const n = Math.max(1, Math.ceil(total / BATCH));
  const base = Math.floor(total / n), extra = total % n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}
