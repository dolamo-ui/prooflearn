// Copies the files that read scanned PDFs (OCR) into public/ocr, so the page can load them from your own
// server. Nothing is downloaded from the internet when someone uses the app, and the PDF never leaves their device.
// Runs automatically after `npm install`. You can also run it by hand: node scripts/copy-ocr-assets.mjs
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = join(root, "node_modules");
const out = join(root, "public", "ocr");
const files = [
  ["pdfjs-dist/build/pdf.min.mjs", "pdf.min.mjs"],
  ["pdfjs-dist/build/pdf.worker.min.mjs", "pdf.worker.min.mjs"],
  ["tesseract.js/dist/tesseract.min.js", "tesseract.min.js"],
  ["tesseract.js/dist/worker.min.js", "worker.min.js"],
  ["tesseract.js-core/tesseract-core-simd-lstm.wasm.js", "core/tesseract-core-simd-lstm.wasm.js"],
  ["tesseract.js-core/tesseract-core-lstm.wasm.js", "core/tesseract-core-lstm.wasm.js"],
  ["@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", "lang/eng.traineddata.gz"],
];
let missing = 0;
for (const [from, to] of files) {
  const src = join(nm, from), dest = join(out, to);
  if (!existsSync(src)) { console.warn(`[ocr] missing ${from} (run npm install)`); missing++; continue; }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
}
console.log(missing ? `[ocr] ${missing} file(s) missing. Scanned PDFs will not work until npm install finishes.` : "[ocr] reading-scanned-PDF files are ready in public/ocr");
