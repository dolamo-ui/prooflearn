/* One place that turns a note or a course document into a tidy PDF or a Word (.doc) file.
   1. It reads the text and finds the structure: title, headings, "Term: meaning" lists, bullets and numbered steps.
   2. It lays that structure out on A4 pages with real margins, so no word is ever cut off.
   Runs in the browser only. Nothing here talks to the server. */

export type Run = { t: string; b?: boolean; i?: boolean };
export type Block =
  | { k: "sub"; t: string }                       // a subtitle line under the title
  | { k: "h2"; t: string }
  | { k: "h3"; t: string }
  | { k: "p"; runs: Run[] }
  | { k: "li"; runs: Run[]; marker: string }      // marker is "•" or "1."
  | { k: "gap" };

const escH = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ============================ 1. find the structure in plain text ============================ */
const BULLET = /^\s*([-*•–—▪●◦]|\d{1,3}[.)])\s+(\S.*)$/;
const TERM = /^([A-Z][^:.!?\n]{0,48}):\s+(\S.*)$/;
const wordCount = (s: string) => s.trim().split(/\s+/).length;
const isTerm = (l: string) => { const m = TERM.exec(l); return !!m && wordCount(m[1]) <= 6 && !/https?$/i.test(m[1]); };

/** "1. Collect 2. Clean 3. Train" all on one line becomes three lines. Needs the numbers to count up from 1. */
function splitSteps(s: string): string[] {
  const re = /(^|\s)(\d{1,2})\.\s+(?=\S)/g;
  const hits: number[] = [];
  let want = 1, m: RegExpExecArray | null;
  while ((m = re.exec(s))) if (Number(m[2]) === want) { hits.push(m.index + m[1].length); want++; }
  if (hits.length < 2) return [s];
  const out: string[] = [];
  if (hits[0] > 0) out.push(s.slice(0, hits[0]).trim());
  hits.forEach((h, i) => out.push(s.slice(h, i + 1 < hits.length ? hits[i + 1] : undefined).trim()));
  return out.filter(Boolean);
}
/** "Edge AI: runs on phones - Explainable AI: gives reasons" on one line becomes two lines. */
function splitDashTerms(s: string): string[] {
  const parts = s.split(/\s[-–—]\s+(?=[A-Z][^:.!?\n]{0,40}:\s)/).map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts : [s];
}

type Kind = "head" | "bullet" | "term" | "text";

export function noteBlocks(body: string, opt: { level?: "h2" | "h3"; sub?: boolean } = {}): Block[] {
  const level = opt.level ?? "h2";
  // 1. split into lines ("" = blank line)
  const lines: string[] = [];
  for (const raw of body.replace(/\r/g, "").replace(/\t/g, " ").split("\n")) {
    const l = raw.trim();
    if (!l) { lines.push(""); continue; }
    for (const a of splitSteps(l)) for (const b of splitDashTerms(a)) lines.push(b);
  }
  // 2. what is each line?
  const kinds: (Kind | "")[] = lines.map((l, i) => {
    if (!l) return "";
    if (BULLET.test(l)) return "bullet";
    if (isTerm(l)) return "term";
    const next = lines[i + 1] || lines[i + 2] || "";   // a heading may be followed by one blank line
    const prevBlank = i === 0 || lines[i - 1] === "";
    const nextIsRich = !!next && (BULLET.test(next) || isTerm(next) || next.length > 45 || (i === 0 && lines[1] === ""));
    if (prevBlank && nextIsRich && l.length <= 70 && wordCount(l) <= 9 && !/[.!?,;]$/.test(l)) return "head";
    return "text";
  });
  const headCount = kinds.filter((k) => k === "head").length;
  // 3. build the blocks
  const blocks: Block[] = [];
  let firstHead = true;
  lines.forEach((l, i) => {
    const k = kinds[i];
    if (!k) { return; }
    const prevK = i > 0 ? kinds[i - 1] : "";
    const nextK = i + 1 < lines.length ? kinds[i + 1] : "";
    const last = blocks[blocks.length - 1];
    if (k === "head") {
      const t = l.replace(/:$/, "");
      if (firstHead && opt.sub !== false && headCount >= 2 && !blocks.length) blocks.push({ k: "sub", t });
      else blocks.push({ k: level, t });
      firstHead = false;
    } else if (k === "bullet") {
      const m = BULLET.exec(l)!;
      const marker = /\d/.test(m[1]) ? m[1].replace(/\)$/, ".") : "•";
      blocks.push({ k: "li", marker, runs: termRuns(m[2]) });
    } else if (k === "term") {
      const inList = prevK === "term" || nextK === "term";
      if (inList) blocks.push({ k: "li", marker: "•", runs: termRuns(l) });
      else blocks.push({ k: "p", runs: termRuns(l) });
    } else {
      const prevText = i > 0 ? lines[i - 1] : "";
      if (last && last.k === "p" && prevK === "text" && !/[.!?:;]$/.test(prevText)) last.runs.push({ t: " " + l });
      else if (last && last.k === "li" && (prevK === "bullet" || prevK === "term") && /^[a-z(]/.test(l)) last.runs.push({ t: " " + l });
      else blocks.push({ k: "p", runs: [{ t: l }] });
    }
  });
  return blocks;
}
function termRuns(s: string): Run[] {
  const m = TERM.exec(s);
  return m && wordCount(m[1]) <= 6 ? [{ t: m[1] + ":", b: true }, { t: " " + m[2] }] : [{ t: s }];
}

/* ============================ 2. read structure from HTML (course book, teacher pack) ============================ */
export function htmlBlocks(html: string): { title: string; blocks: Block[] } {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  let title = "";
  const blocks: Block[] = [];
  const runsOf = (n: Node, b = false, i = false, out: Run[] = []): Run[] => {
    n.childNodes.forEach((c) => {
      if (c.nodeType === 3) out.push({ t: c.textContent || "", b, i });
      else if (c.nodeType === 1) {
        const tag = (c as Element).tagName;
        if (tag === "BR") out.push({ t: "\n" });
        else runsOf(c, b || tag === "B" || tag === "STRONG", i || tag === "I" || tag === "EM", out);
      }
    });
    return out;
  };
  const hasText = (r: Run[]) => r.some((x) => x.t.trim());
  const walk = (el: Element) => {
    for (const c of Array.from(el.children)) {
      const tag = c.tagName;
      if (tag === "H1") { const t = (c.textContent || "").trim(); if (!title) title = t; else if (t) blocks.push({ k: "h2", t }); }
      else if (tag === "H2") { const t = (c.textContent || "").trim(); if (t) blocks.push({ k: "h2", t }); }
      else if (/^H[3-6]$/.test(tag)) { const t = (c.textContent || "").trim(); if (t) blocks.push({ k: "h3", t }); }
      else if (tag === "P") { const r = runsOf(c); if (hasText(r)) blocks.push({ k: "p", runs: r }); }
      else if (tag === "UL" || tag === "OL") {
        let n = 0;
        for (const li of Array.from(c.children)) {
          if (li.tagName !== "LI") continue;
          n++;
          const r = runsOf(li);
          if (hasText(r)) blocks.push({ k: "li", runs: r, marker: tag === "OL" ? `${n}.` : "•" });
        }
        blocks.push({ k: "gap" });
      }
      else if (tag === "PRE") blocks.push(...noteBlocks(c.textContent || "", { level: "h3", sub: false }));
      else if (tag === "HR") { /* skip */ }
      else walk(c);
    }
  };
  walk(doc.body);
  return { title, blocks };
}

/* ============================ 3. Word ============================ */
const runsHtml = (runs: Run[]) => runs.map((r) => {
  let h = escH(r.t).replace(/\n/g, "<br>");
  if (r.i) h = `<i>${h}</i>`;
  if (r.b) h = `<b>${h}</b>`;
  return h;
}).join("");

export function blocksHtml(blocks: Block[]): string {
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const b of blocks) {
    if (b.k === "li") {
      const want = /\d/.test(b.marker) ? "ol" : "ul";
      if (list !== want) { close(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${runsHtml(b.runs)}</li>`);
      continue;
    }
    close();
    if (b.k === "sub") out.push(`<h2 class="sub">${escH(b.t)}</h2>`);
    else if (b.k === "h2") out.push(`<h2>${escH(b.t)}</h2>`);
    else if (b.k === "h3") out.push(`<h3>${escH(b.t)}</h3>`);
    else if (b.k === "p") out.push(`<p>${runsHtml(b.runs)}</p>`);
  }
  close();
  return out.join("\n");
}

const WORD_CSS = `body{font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.45;color:#222a40}
h1{font-size:22pt;color:#18245e;margin:0 0 4pt;border-bottom:2.5pt solid #2548c8;padding-bottom:4pt}
h2{font-size:15pt;color:#18245e;margin:16pt 0 4pt}h2.sub{font-size:14pt;color:#2548c8;margin-top:8pt}
h3{font-size:12.5pt;color:#18245e;margin:12pt 0 3pt}p{margin:0 0 7pt}li{margin:0 0 3pt}
.meta{font-size:9.5pt;color:#6e748c;margin:0 0 10pt}`;

/** Wraps a body of HTML as a Word file that opens in Print Layout. */
export function wordPage(title: string, bodyHtml: string): string {
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>${escH(title)}</title>` +
    `<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->` +
    `<style>${WORD_CSS}</style></head><body>${bodyHtml}</body></html>`;
}

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
export const safeName = (s: string, fallback = "note") => s.replace(/[^\p{L}\p{N} _-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 60) || fallback;
const today = () => new Date().toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" });

export function downloadNoteWord(title: string, body: string) {
  const t = title || "Untitled note";
  const html = `<h1>${escH(t)}</h1><p class="meta">ProofLearn note &middot; ${escH(today())}</p>${blocksHtml(noteBlocks(body))}`;
  saveBlob(new Blob([wordPage(t, html)], { type: "application/msword" }), `${safeName(t)}.doc`);
}

/* ============================ 4. PDF ============================ */
// The built-in PDF fonts only hold Latin letters. Fancy punctuation is swapped for plain; anything else becomes "?".
const SWAP: [RegExp, string][] = [[/[\u2018\u2019\u201A]/g, "'"], [/[\u201C\u201D\u201E]/g, '"'], [/\u2014/g, " - "], [/\u2013/g, "-"], [/\u2026/g, "..."], [/[\u2022\u25CF\u25AA\u25E6]/g, "-"], [/\u2192/g, "->"], [/\u2713|\u2714/g, "(correct)"], [/[\u00A0\u2009\u200A\u202F]/g, " "], [/[\u200B\uFEFF]/g, ""]];
function latin(s: string, flag: { lossy: boolean }): string {
  let t = s;
  for (const [re, to] of SWAP) t = t.replace(re, to);
  return t.replace(/[^\u0020-\u007E\u00C0-\u00FF\n]/g, () => { flag.lossy = true; return "?"; });
}

type Tok = { w: string; b: boolean; i: boolean; sp: boolean; nl: boolean };
type Placed = { w: string; b: boolean; i: boolean; x: number };

export async function buildPdf(title: string, blocks: Block[], opt: { meta?: string } = {}) {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ unit: "mm", format: "a4" });
  pdf.setProperties({ title });
  const flag = { lossy: false };
  const W = 210, H = 297, ML = 20, MR = 20, MT = 22, MB = 24, TW = W - ML - MR, BOTTOM = H - MB;
  const NAVY: [number, number, number] = [24, 36, 94], INK: [number, number, number] = [34, 42, 64], GREY: [number, number, number] = [110, 116, 140], BLUE: [number, number, number] = [37, 72, 200], RULE: [number, number, number] = [214, 220, 240];
  const MM = 0.3528;                                   // millimetres in one point
  let y = MT;

  const style = (b: boolean, i: boolean) => (b ? (i ? "bolditalic" : "bold") : i ? "italic" : "normal");
  const font = (size: number, b = false, i = false) => { pdf.setFont("helvetica", style(b, i)); pdf.setFontSize(size); };
  const room = (h: number) => { if (y + h > BOTTOM) { pdf.addPage(); y = MT; return true; } return false; };

  /** Cut text into tokens (words) that remember bold/italic and whether a space came before them. */
  const tokens = (runs: Run[]): Tok[] => {
    const out: Tok[] = [];
    let sp = false;
    for (const r of runs) {
      for (const part of latin(r.t, flag).split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part)) { if (part.includes("\n")) { out.push({ w: "", b: false, i: false, sp: false, nl: true }); sp = false; } else sp = true; }
        else { out.push({ w: part, b: !!r.b, i: !!r.i, sp: sp && out.length > 0 && !out[out.length - 1].nl, nl: false }); sp = false; }
      }
    }
    return out;
  };
  /** Wrap tokens into lines that fit `width`. A word longer than a whole line is split so it can never run off the page. */
  const wrap = (runs: Run[], width: number, size: number): Placed[][] => {
    const lines: Placed[][] = [];
    let cur: Placed[] = [], x = 0;
    font(size);
    const space = pdf.getTextWidth(" ");
    const flush = () => { lines.push(cur); cur = []; x = 0; };
    for (const t of tokens(runs)) {
      if (t.nl) { flush(); continue; }
      font(size, t.b, t.i);
      let word = t.w, w = pdf.getTextWidth(word);
      while (w > width) {                               // very long word: break it by letters
        let n = word.length;
        while (n > 1 && pdf.getTextWidth(word.slice(0, n)) > width) n--;
        if (cur.length) flush();
        cur.push({ w: word.slice(0, n), b: t.b, i: t.i, x: 0 }); flush();
        word = word.slice(n); w = pdf.getTextWidth(word);
      }
      if (!word) continue;
      const gap = cur.length && t.sp ? space : 0;
      if (cur.length && x + gap + w > width) flush();
      const gx = cur.length && t.sp ? space : 0;
      cur.push({ w: word, b: t.b, i: t.i, x: x + gx });
      x += gx + w;
    }
    if (cur.length) flush();
    return lines.length ? lines : [[]];
  };

  const draw = (lines: Placed[][], x0: number, size: number, lh: number, color: [number, number, number], bold = false, onLine?: (first: boolean) => void) => {
    lines.forEach((line, n) => {
      const moved = room(lh);
      if (onLine) onLine(n === 0 || moved);
      pdf.setTextColor(...color);
      const base = y + lh / 2 + size * MM * 0.33;
      for (const p of line) { font(size, p.b || bold, p.i); pdf.text(p.w, x0 + p.x, base); }
      y += lh;
    });
  };
  const lhOf = (size: number, f = 1.5) => size * MM * f;
  const plain = (s: string): Run[] => [{ t: s }];

  // ---- title block ----
  {
    const size = 22, lh = lhOf(size, 1.25);
    const lines = wrap([{ t: title, b: true }], TW, size);
    draw(lines, ML, size, lh, NAVY, true);
    y += 1.5;
    pdf.setFillColor(...BLUE); pdf.rect(ML, y, 30, 1.1, "F"); y += 4.5;
    if (opt.meta) { draw(wrap(plain(opt.meta), TW, 9.5), ML, 9.5, lhOf(9.5), GREY); }
    y += 5;
  }

  const lastIsHeading = () => false;
  void lastIsHeading;
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    if (b.k === "gap") { y += 2; continue; }
    if (b.k === "sub") {
      const size = 14, lh = lhOf(size, 1.35);
      const lines = wrap([{ t: b.t, b: true }], TW, size);
      room(lh * lines.length + lhOf(11) * 2);
      draw(lines, ML, size, lh, BLUE, true); y += 2.5; continue;
    }
    if (b.k === "h2" || b.k === "h3") {
      const h2 = b.k === "h2", size = h2 ? 14 : 12, lh = lhOf(size, 1.35), before = h2 ? 7 : 5;
      const lines = wrap([{ t: b.t, b: true }], TW, size);
      if (y > MT + 0.5) y += before;
      room(lh * lines.length + (h2 ? 2.5 : 1.5) + lhOf(11) * 2.2);   // keep the heading together with the lines after it
      draw(lines, ML, size, lh, NAVY, true);
      if (h2) { pdf.setDrawColor(...RULE); pdf.setLineWidth(0.3); pdf.line(ML, y + 0.4, W - MR, y + 0.4); y += 2.6; } else y += 1.5;
      continue;
    }
    if (b.k === "p") {
      const size = 11, lh = lhOf(size, 1.5);
      draw(wrap(b.runs, TW, size), ML, size, lh, INK);
      y += 2.8; continue;
    }
    if (b.k === "li") {
      const size = 11, lh = lhOf(size, 1.5), IND = 8;
      const lines = wrap(b.runs, TW - IND, size);
      draw(lines, ML + IND, size, lh, INK, false, (first) => {
        if (!first) return;
        pdf.setTextColor(...BLUE);
        if (b.marker === "•") { pdf.setFillColor(...BLUE); pdf.circle(ML + 2.6, y + lh / 2, 0.6, "F"); }
        else { font(size, true); pdf.text(b.marker, ML + IND - 2, y + lh / 2 + size * MM * 0.33, { align: "right" }); }
      });
      y += 1.6; continue;
    }
  }

  // ---- footer on every page ----
  const pages = pdf.getNumberOfPages();
  const shortTitle = latin(title, flag).length > 70 ? latin(title, flag).slice(0, 67) + "..." : latin(title, flag);
  for (let p = 1; p <= pages; p++) {
    pdf.setPage(p);
    pdf.setDrawColor(...RULE); pdf.setLineWidth(0.3); pdf.line(ML, H - 15, W - MR, H - 15);
    font(8.5); pdf.setTextColor(...GREY);
    pdf.text(shortTitle, ML, H - 10);
    pdf.text(`Page ${p} of ${pages}`, W - MR, H - 10, { align: "right" });
  }
  return { pdf, lossy: flag.lossy };
}

/** Download a note as a tidy PDF. */
export async function downloadNotePdf(title: string, body: string): Promise<{ lossy: boolean }> {
  const t = title || "Untitled note";
  const { pdf, lossy } = await buildPdf(t, noteBlocks(body), { meta: `ProofLearn note  |  ${today()}` });
  saveBlob(pdf.output("blob"), `${safeName(t)}.pdf`);
  return { lossy };
}

/** Download a course document written as HTML (learning book, teacher pack) as a tidy PDF. */
export async function downloadHtmlPdf(fileName: string, fallbackTitle: string, html: string): Promise<{ lossy: boolean }> {
  const { title, blocks } = htmlBlocks(html);
  const t = title || fallbackTitle;
  const { pdf, lossy } = await buildPdf(t, blocks, { meta: today() });
  saveBlob(pdf.output("blob"), fileName.endsWith(".pdf") ? fileName : fileName.replace(/\.[a-z]+$/i, "") + ".pdf");
  return { lossy };
}
