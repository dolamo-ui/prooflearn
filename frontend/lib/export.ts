/* Turns a test or classwork into a Word file, a PDF, or a printable page.
   Two copies: the STUDENT copy (no answers, with space to write) and the TEACHER copy (with the memo).
   Runs in the browser only. Every piece of text is escaped before it goes into HTML. */
import { esc } from "./client";

export type ExportQ = { kind: "choice" | "explain" | "order"; text: string; topic: string; why: string; options: string[]; answer: number; steps: string[]; expected: string };
export type ExportDoc = { title: string; kindName: string; instructions: string; questions: ExportQ[]; withAnswers: boolean };

const LETTER = "ABCDEF";

/** Steps shown mixed up on the student copy (always different from the correct order). */
export function mixSteps(steps: string[]): string[] {
  if (steps.length < 2) return steps;
  const out = steps.map((_, i) => steps[(i * 2 + 1) % steps.length]);
  const uniq = new Set(out).size === steps.length;
  const mixed = uniq && out.some((s, i) => s !== steps[i]) ? out : [...steps.slice(1), steps[0]];
  return mixed;
}

const fileBase = (d: ExportDoc) => `${d.title.replace(/[^\p{L}\p{N} _-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 50) || "test"} - ${d.withAnswers ? "teacher copy" : "student copy"}`;

/* ---------------------------- Word / print (HTML) ---------------------------- */
export function docHtml(d: ExportDoc): string {
  const out: string[] = [];
  out.push(`<h1>${esc(d.title)}</h1>`);
  out.push(`<p><b>${esc(d.kindName)}</b>${d.withAnswers ? " &mdash; TEACHER COPY (memo included)" : ""} &nbsp;|&nbsp; ${d.questions.length} question${d.questions.length === 1 ? "" : "s"} &nbsp;|&nbsp; Total: ${d.questions.length} mark${d.questions.length === 1 ? "" : "s"}</p>`);
  if (!d.withAnswers) out.push(`<p>Name: ______________________________ &nbsp;&nbsp; Date: ______________ &nbsp;&nbsp; Mark: ______ / ${d.questions.length}</p>`);
  if (d.instructions) out.push(`<p><b>Instructions:</b> ${esc(d.instructions)}</p>`);
  out.push("<hr>");
  d.questions.forEach((q, i) => {
    out.push(`<p style="margin-top:14pt"><b>${i + 1}.</b> ${esc(q.text)} <small>(1 mark)</small></p>`);
    if (q.kind === "choice") {
      out.push(q.options.map((o, j) => `<p style="margin:2pt 0 2pt 24pt">${LETTER[j]}. ${esc(o)}${d.withAnswers && j === q.answer ? " &nbsp;<b>&#10003; correct</b>" : ""}</p>`).join(""));
    } else if (q.kind === "order") {
      out.push(`<p style="margin:2pt 0 2pt 24pt"><i>Write the numbers 1 to ${q.steps.length} to put these steps in the correct order.</i></p>`);
      const shown = d.withAnswers ? q.steps : mixSteps(q.steps);
      out.push(shown.map((s, j) => d.withAnswers ? `<p style="margin:2pt 0 2pt 24pt">${j + 1}. ${esc(s)}</p>` : `<p style="margin:2pt 0 2pt 24pt">[ &nbsp; ] ${esc(s)}</p>`).join(""));
    } else if (!d.withAnswers) {
      out.push(`<p style="margin:10pt 0 0 24pt">_______________________________________________________________</p>`.repeat(3));
    }
    if (d.withAnswers) {
      if (q.kind === "explain") out.push(`<p style="margin:2pt 0 2pt 24pt"><b>Memo:</b> ${esc(q.expected)}</p>`);
      if (q.why) out.push(`<p style="margin:2pt 0 2pt 24pt"><i>${esc(q.why)}</i></p>`);
    }
  });
  return out.join("\n");
}

export function downloadDocWord(d: ExportDoc) {
  const html = `<html><head><meta charset="utf-8"><title>${esc(d.title)}</title><style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt}h1{font-size:18pt}small{color:#555}</style></head><body>${docHtml(d)}</body></html>`;
  save(new Blob([html], { type: "application/msword" }), `${fileBase(d)}.doc`);
}

/* ---------------------------------- PDF ---------------------------------- */
// The built-in PDF fonts only hold Latin letters. Fancy punctuation is swapped for plain, anything else becomes "?".
const SWAP: [RegExp, string][] = [[/[\u2018\u2019]/g, "'"], [/[\u201C\u201D]/g, '"'], [/[\u2013\u2014]/g, "-"], [/\u2026/g, "..."], [/[\u2022\u25CF]/g, "-"], [/\u2192/g, "->"], [/\u2713|\u2714/g, "(correct)"], [/\u00A0/g, " "]];
function latin(s: string, flag: { lossy: boolean }): string {
  let t = s;
  for (const [re, to] of SWAP) t = t.replace(re, to);
  return t.replace(/[^\u0020-\u007E\u00C0-\u00FF\n]/g, () => { flag.lossy = true; return "?"; });
}

export async function downloadDocPdf(d: ExportDoc): Promise<{ lossy: boolean }> {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ unit: "mm", format: "a4" });
  const flag = { lossy: false };
  const W = 210, M = 18, TEXT_W = W - 2 * M, BOTTOM = 280;
  let y = M;
  const room = (h: number) => { if (y + h > BOTTOM) { pdf.addPage(); y = M; } };
  const put = (raw: string, o: { size?: number; bold?: boolean; italic?: boolean; indent?: number; gap?: number } = {}) => {
    const size = o.size ?? 11;
    pdf.setFont("helvetica", o.bold ? "bold" : o.italic ? "italic" : "normal");
    pdf.setFontSize(size);
    const lh = size * 0.4;
    const lines: string[] = pdf.splitTextToSize(latin(raw, flag), TEXT_W - (o.indent ?? 0));
    for (const line of lines) { room(lh); pdf.text(line, M + (o.indent ?? 0), y + lh * 0.8); y += lh; }
    y += o.gap ?? 1.5;
  };
  put(d.title, { size: 17, bold: true, gap: 2 });
  put(`${d.kindName}${d.withAnswers ? " - TEACHER COPY (memo included)" : ""}   |   ${d.questions.length} question${d.questions.length === 1 ? "" : "s"}   |   Total: ${d.questions.length} mark${d.questions.length === 1 ? "" : "s"}`, { size: 10, italic: true, gap: 3 });
  if (!d.withAnswers) put(`Name: ______________________________    Date: _______________    Mark: ______ / ${d.questions.length}`, { gap: 3 });
  if (d.instructions) put(`Instructions: ${d.instructions}`, { gap: 3 });
  pdf.setDrawColor(150); room(4); pdf.line(M, y, W - M, y); y += 5;

  d.questions.forEach((q, i) => {
    room(18);
    put(`${i + 1}. ${q.text}  (1 mark)`, { bold: true, gap: 1.5 });
    if (q.kind === "choice") q.options.forEach((o, j) => put(`${LETTER[j]}.  ${o}${d.withAnswers && j === q.answer ? "   <-- correct" : ""}`, { indent: 8, bold: d.withAnswers && j === q.answer, gap: 0.8 }));
    else if (q.kind === "order") {
      put(`Write the numbers 1 to ${q.steps.length} to put these steps in the correct order.`, { indent: 8, italic: true, gap: 1 });
      (d.withAnswers ? q.steps : mixSteps(q.steps)).forEach((s, j) => put(d.withAnswers ? `${j + 1}.  ${s}` : `[    ]  ${s}`, { indent: 8, gap: 0.8 }));
    } else if (!d.withAnswers) {
      for (let k = 0; k < 3; k++) { room(9); y += 7; pdf.setDrawColor(190); pdf.line(M + 8, y, W - M, y); }
      y += 2;
    }
    if (d.withAnswers) {
      if (q.kind === "explain") put(`Memo: ${q.expected}`, { indent: 8, bold: true, gap: 1 });
      if (q.why) put(q.why, { indent: 8, italic: true, size: 10, gap: 1 });
    }
    y += 3;
  });
  const pages = pdf.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    pdf.setPage(p); pdf.setFont("helvetica", "normal"); pdf.setFontSize(9); pdf.setTextColor(120);
    pdf.text(`${latin(d.title, flag)}  -  page ${p} of ${pages}`, M, 290);
  }
  save(pdf.output("blob"), `${fileBase(d)}.pdf`);
  return flag;
}

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
