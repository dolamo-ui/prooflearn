/* Reads a PDF INSIDE THE BROWSER. Used when the server cannot (a scan, or a PDF whose text was turned into pictures),
   or when the file is too big to upload. The file never leaves the person's device.
   1. Try the PDF's own text. 2. If there is none, look at each page as a picture and read it (OCR).
   All the files come from /ocr on our own server (see scripts/copy-ocr-assets.mjs). */

export const MAX_PAGES = 30;
type Status = (message: string) => void;

let pdfjsReady: Promise<any> | null = null;
function loadPdfJs(): Promise<any> {
  return (pdfjsReady ||= (async () => {
    const url = "/ocr/pdf.min.mjs";                               // a variable + webpackIgnore: load it as-is, do not bundle it
    const lib = await import(/* webpackIgnore: true */ url).catch(() => { throw new Error("ocr-missing"); });
    lib.GlobalWorkerOptions.workerSrc = "/ocr/pdf.worker.min.mjs";
    return lib;
  })());
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as any).Tesseract) return resolve();
    const s = document.createElement("script");
    s.src = src; s.onload = () => resolve(); s.onerror = () => reject(new Error("ocr-missing"));
    document.head.appendChild(s);
  });
}

const MISSING = "The reader for scanned pages is not installed on this server yet. Run “npm install” again (see README), or paste the text instead.";

export async function readPdfInBrowser(file: File, onStatus: Status = () => undefined): Promise<string> {
  let pdfjs: any;
  try { pdfjs = await loadPdfJs(); } catch { throw new Error(MISSING); }

  let doc: any;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  } catch (e: any) {
    if (e?.name === "PasswordException") throw new Error("This PDF is password-protected. Remove the password (open it, then save a copy without one) and upload it again.");
    throw new Error("This PDF looks damaged and could not be opened. Try saving or exporting it again from the program that made it.");
  }
  const pages: number = doc.numPages;
  if (pages > MAX_PAGES) throw new Error(`That PDF has ${pages} pages. The limit is ${MAX_PAGES}. Upload fewer pages.`);

  // 1. The PDF's own text (fast)
  let text = "";
  for (let i = 1; i <= pages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    text += tc.items.map((it: any) => (it.str ?? "") + (it.hasEOL ? "\n" : " ")).join("") + "\n\n";
  }
  if (text.replace(/\s/g, "").length >= 40) return tidy(text);

  // 2. No text: read each page like a photo
  onStatus("This PDF is made of pictures, so I will read it like a photo. The first time takes a little longer…");
  try { await loadScript("/ocr/tesseract.min.js"); } catch { throw new Error(MISSING); }
  const T = (window as any).Tesseract;
  const worker = await T.createWorker("eng", 1, {
    workerPath: "/ocr/worker.min.js", corePath: "/ocr/core", langPath: "/ocr/lang", gzip: true, workerBlobURL: false, logger: () => undefined,
  }).catch(() => { throw new Error(MISSING); });
  let out = "";
  try {
    for (let i = 1; i <= pages; i++) {
      onStatus(`Reading page ${i} of ${pages}… (about 5 seconds a page, nothing is uploaded)`);
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(3, Math.max(1.5, 2200 / Math.max(base.width, base.height)));
      const view = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(view.width); canvas.height = Math.ceil(view.height);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);   // many PDFs have a see-through page
      await page.render({ canvasContext: ctx, viewport: view }).promise;
      const { data } = await worker.recognize(canvas);
      out += (data.text || "") + "\n\n";
      canvas.width = canvas.height = 0;                                          // free the memory
    }
  } finally {
    await worker.terminate().catch(() => undefined);
  }
  if (out.replace(/\s/g, "").length < 20) throw new Error("I could not find any writing on those pages, even by reading them like a photo. Is the page blank, or is the photo too dark or blurry?");
  return tidy(out);
}

const tidy = (t: string) => t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
