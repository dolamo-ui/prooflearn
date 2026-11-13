/* RAG = "retrieve, then answer". Instead of giving the AI a whole document,
   we cut it into passages, rank them against the question (BM25, the same idea
   search engines use) and give the AI only the best few. Every passage keeps a
   number, so an answer can say exactly which passage it came from. */

const STOP_WORDS = new Set([
  "about", "after", "again", "also", "and", "are", "because", "been", "before",
  "being", "but", "can", "could", "did", "does", "for", "from", "have", "into",
  "its", "more", "most", "not", "our", "please", "should", "than", "that", "the",
  "their", "them", "then", "there", "these", "this", "those", "through", "under",
  "use", "was", "were", "what", "when", "where", "which", "who", "will", "with",
  "would", "your",
]);

export type Chunk = { id: number; text: string };

/** Cut text into passages of about 400-900 characters, never in the middle of a sentence if avoidable. */
export function chunkText(source: string, target = 900): Chunk[] {
  const paragraphs = source.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter(Boolean);
  const pieces = paragraphs.flatMap((p) => {
    if (p.length <= target) return [p];
    const out: string[] = [];
    let cur = "";
    for (const sentence of p.split(/(?<=[.!?])\s+/)) {
      if (sentence.length > target) { // one huge "sentence": cut by length
        if (cur) { out.push(cur); cur = ""; }
        for (let i = 0; i < sentence.length; i += target) out.push(sentence.slice(i, i + target));
      } else if ((cur + " " + sentence).length > target) { out.push(cur); cur = sentence; }
      else cur = cur ? `${cur} ${sentence}` : sentence;
    }
    if (cur) out.push(cur);
    return out;
  });
  // join very short neighbours (headings, list items) so passages carry enough meaning
  const merged: string[] = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (last && last.length < 400 && (last + "\n\n" + piece).length <= target) merged[merged.length - 1] = `${last}\n\n${piece}`;
    else merged.push(piece);
  }
  return merged.map((text, i) => ({ id: i + 1, text }));
}

const stem = (w: string) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter((w) => !STOP_WORDS.has(w)).map(stem);
}

/** The k passages that best match the query, in reading order. */
export function retrieve(source: string, query: string, k = 6): Chunk[] {
  const chunks = chunkText(source.trim());
  if (!chunks.length) return [];
  const q = Array.from(new Set(tokens(query)));
  const docs = chunks.map((c) => tokens(c.text));
  const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  docs.forEach((d) => new Set(d).forEach((t) => df.set(t, (df.get(t) || 0) + 1)));
  const k1 = 1.2, b = 0.75;
  const scored = chunks.map((c, i) => {
    const tf = new Map<string, number>();
    docs[i].forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
    let score = 0;
    for (const t of q) {
      const f = tf.get(t) || 0;
      if (!f) continue;
      const idf = Math.log(1 + (chunks.length - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * docs[i].length) / avg)));
    }
    return { c, score };
  });
  const hits = scored.filter((s) => s.score > 0);
  const chosen = (hits.length ? hits.sort((a, z) => z.score - a.score) : scored).slice(0, k);
  return chosen.map((s) => s.c).sort((a, z) => a.id - z.id);
}

/** For "test me on the whole note": passages spread evenly from start to end. */
export function spread(source: string, k = 6): Chunk[] {
  const chunks = chunkText(source.trim());
  if (chunks.length <= k) return chunks;
  const step = chunks.length / k;
  return Array.from({ length: k }, (_, i) => chunks[Math.floor(i * step)]);
}

export const asPassages = (chunks: Chunk[]) => chunks.map((c) => `[${c.id}] ${c.text}`).join("\n\n");

/** Older callers: one block of text. */
export function retrieveSourceText(source: string, query: string, maxChunks = 5, maxChars = 4000): string {
  return retrieve(source, query, maxChunks).map((c) => c.text).join("\n\n").slice(0, maxChars);
}

/** Passages for ONE batch of a big test. The note (or the best matches for a focus) is cut into
    `parts` consecutive slices, and batch number `part` uses its own slice. This makes a long test
    cover the whole note, start to end, instead of asking about the same paragraph again and again. */
export function pickPassages(source: string, focus: string, part = 0, parts = 1, k = 6): Chunk[] {
  const all = focus ? retrieve(source, focus, k * parts) : chunkText(source.trim());
  if (!all.length) return [];
  const a = Math.floor((part * all.length) / parts);
  const b = Math.max(a + 1, Math.floor(((part + 1) * all.length) / parts));
  const slice = all.slice(a, b);
  if (slice.length <= k) return slice;
  const step = slice.length / k;
  return Array.from({ length: k }, (_, i) => slice[Math.floor(i * step)]);
}
