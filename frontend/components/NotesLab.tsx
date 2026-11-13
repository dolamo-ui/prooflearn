"use client";
import { useEffect, useRef, useState } from "react";
import { addLocalNote, api, downloadNotePdf, downloadWord, loadNotes, NOTE_MAX, readFileText, saveNotes, type LocalNote, type Role } from "../lib/client";
import AiHelper from "./AiHelper";
import ShareBox from "./ShareBox";
import { noteBlocks, type Block, type Run } from "../lib/pdf";
import { CopyButton, HowTo, Msg, Page, PasscodeBox, useConfirm } from "./ui";

const RunsView = ({ runs }: { runs: Run[] }) => <>{runs.map((r, i) => <span key={i} style={{ fontWeight: r.b ? 700 : undefined, fontStyle: r.i ? "italic" : undefined, whiteSpace: "pre-line" }}>{r.t}</span>)}</>;
/** The note laid out as headings, paragraphs and lists. This is what "Print" shows. */
function PrintBlocks({ blocks }: { blocks: Block[] }) {
  const out: JSX.Element[] = [];
  let items: Block[] = [];
  const flush = (key: number) => {
    if (!items.length) return;
    const numbered = items[0].k === "li" && /\d/.test((items[0] as { marker: string }).marker);
    const lis = items.map((b, i) => <li key={i}><RunsView runs={(b as { runs: Run[] }).runs} /></li>);
    out.push(numbered ? <ol key={"l" + key}>{lis}</ol> : <ul key={"l" + key}>{lis}</ul>);
    items = [];
  };
  blocks.forEach((b, i) => {
    if (b.k === "li") { items.push(b); return; }
    flush(i);
    if (b.k === "sub") out.push(<h2 key={i} className="print-sub">{b.t}</h2>);
    else if (b.k === "h2") out.push(<h2 key={i}>{b.t}</h2>);
    else if (b.k === "h3") out.push(<h3 key={i}>{b.t}</h3>);
    else if (b.k === "p") out.push(<p key={i}><RunsView runs={b.runs} /></p>);
  });
  flush(blocks.length);
  return <>{out}</>;
}

const when = (t: number) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export default function NotesLab({ role, passcode, setPasscode, onBack, onTest, onAsk, startWith }: {
  role: Role; passcode: string; setPasscode: (v: string) => void; onBack: () => void;
  onTest: (n: LocalNote) => void; onAsk: (n: LocalNote) => void; startWith?: string;
}) {
  const confirm = useConfirm();
  const [notes, setNotes] = useState<LocalNote[]>([]);
  const [openId, setOpenId] = useState<string | null>(startWith || null);
  const [msg, setMsg] = useState({ error: "", ok: "" });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(true);
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);   // text the person has selected
  const [undo, setUndo] = useState<{ id: string; body: string } | null>(null);   // the note before the last AI change
  const [aiStart, setAiStart] = useState(false);                                 // opened via "Write a note with AI"
  const file = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const teacher = role === "teacher";

  useEffect(() => { setNotes(loadNotes(role)); }, [role]);
  const open = notes.find((n) => n.id === openId) || null;
  const say = (ok = "", error = "") => setMsg({ ok, error });
  const getPdf = async (title: string, body: string) => {
    try {
      const r = await downloadNotePdf(title, body);
      say(r.lossy ? "PDF downloaded. A few special characters cannot be shown in a PDF and appear as “?”. Use Download as Word to keep them." : "PDF downloaded.");
    } catch { say("", "I could not make the PDF. Try Download as Word instead."); }
  };

  // Always read the newest list from a ref, so typing during a slow network call is never overwritten.
  const latest = useRef<LocalNote[]>([]);
  latest.current = notes;
  // Save on this device 0.5 seconds after typing stops.
  const edit = (patch: Partial<LocalNote>) => {
    const next = latest.current.map((n) => (n.id === openId ? { ...n, ...patch, updatedAt: Date.now() } : n));
    latest.current = next;
    setNotes(next);
    setSaved(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (saveNotes(role, latest.current)) setSaved(true);
      else say("", "This device is full, so I could not save. Download your notes as a Word file to be safe.");
    }, 500);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const create = (title = "", body = "", withAi = false) => {
    const n = addLocalNote(role, title || "My new note", body);
    setNotes(loadNotes(role)); setOpenId(n.id); setSel(null); setUndo(null); setAiStart(withAi); say();
  };

  // The AI suggested text and the person pressed "Use this". Returns a message only if it cannot be applied.
  const applyAi = (mode: "replace" | "append", text: string, selection: { start: number; end: number } | null): string | void => {
    if (!open) return;
    const cur = open.body;
    const next = mode === "append" || cur.trim().length < 1
      ? (cur.trim() ? `${cur.replace(/\s+$/, "")}\n\n${text}` : text)
      : selection ? cur.slice(0, selection.start) + text + cur.slice(selection.end) : text;
    if (next.length > NOTE_MAX) return `That would make the note longer than ${NOTE_MAX.toLocaleString()} letters. Delete some text or start a second note.`;
    setUndo({ id: open.id, body: cur });
    edit({ body: next }); setSel(null);
    say("Done. You can undo it with “Undo the last AI change”.");
  };

  const importFile = async (f?: File) => {
    if (!f) return;
    setBusy(true); say("Reading your file…");
    try {
      const text = await readFileText(f, (m) => say(m));
      const long = text.length > NOTE_MAX;
      create(f.name.replace(/\.[^.]+$/, ""), text);
      say(long ? `Your file is long, so I kept the first ${NOTE_MAX.toLocaleString()} characters. You can split the rest into another note.` : "Your file is now a note you can edit.");
    } catch (e: any) { say("", e.message); }
    setBusy(false);
    if (file.current) file.current.value = "";
  };

  const remove = () => {
    if (!open) return;
    if (!confirm(`Delete "${open.title}" from this device?${open.shared ? " Learners who have the code will still see the shared copy until you stop sharing it." : ""}`)) return;
    const next = notes.filter((n) => n.id !== open.id);
    saveNotes(role, next); setNotes(next); setOpenId(null); say("Note deleted.");
  };

  const share = async () => {
    if (!open) return;
    if (open.body.trim().length < 20) return say("", "Write a little more first. A shared note needs at least 20 characters.");
    setBusy(true); say();
    try {
      if (open.shared) {
        await api("/api/notes", { action: "update", code: open.shared.code, editKey: open.shared.key, title: open.title, body: open.body });
        say("Learners now see your latest version.");
      } else {
        const r = await api<{ code: string; editKey: string }>("/api/notes", { action: "create", passcode, title: open.title, body: open.body });
        edit({ shared: { code: r.code, key: r.editKey } });
        say("Shared! Give learners the code below.");
      }
    } catch (e: any) { say("", e.message); }
    setBusy(false);
  };
  const unshare = async () => {
    if (!open?.shared || !confirm("Stop sharing? Learners will no longer be able to open this code.")) return;
    setBusy(true);
    try {
      await api("/api/notes", { action: "delete", code: open.shared.code, editKey: open.shared.key });
      edit({ shared: undefined }); say("Sharing stopped.");
    } catch (e: any) { say("", e.message); }
    setBusy(false);
  };

  /* ---------- one note ---------- */
  if (open) return (
    <Page title={open.title || "Untitled note"} printTitle={false} onBack={() => { setOpenId(null); say(); }} backLabel="All my notes">
      <div className="no-print">
        <label className="answer-field"><span>Title</span>
          <input value={open.title} maxLength={120} onChange={(e) => edit({ title: e.target.value })} />
        </label>
        <label className="answer-field"><span>Your note <small>— type, paste, or fix anything here</small></span>
          <textarea className="notebody" rows={open.body.trim() ? 16 : 7} maxLength={NOTE_MAX} value={open.body}
            onChange={(e) => { edit({ body: e.target.value }); setSel(null); }}
            onSelect={(e) => { const t = e.currentTarget; setSel(t.selectionEnd > t.selectionStart ? { start: t.selectionStart, end: t.selectionEnd } : null); }}
            placeholder="Type or paste your notes here… or open the AI helper below and ask it to write a first draft." />
        </label>
        <p><small>{open.body.length.toLocaleString()} / {NOTE_MAX.toLocaleString()} characters · {saved ? "Saved on this device ✓" : "Saving…"}</small></p>

        <AiHelper key={open.id + String(aiStart)} role={role} body={open.body} sel={sel} startOpen={open.body.trim().length < 40 || aiStart} focusTopic={aiStart}
          canUndo={undo?.id === open.id} onApply={applyAi} onUndo={() => { if (undo) { edit({ body: undo.body }); setUndo(null); say("Undone."); } }} />

        <h3>What would you like to do with this note?</h3>
        <div className="actions">
          <button className="btn" disabled={open.body.trim().length < 40} onClick={() => onTest(open)}>{teacher ? "Make a test or classwork" : "Test myself"}</button>
          <button className="ghost" disabled={open.body.trim().length < 40} onClick={() => onAsk(open)}>Ask this note a question</button>
          <button className="ghost" onClick={() => { downloadWord(open.title, open.body); say("Word file downloaded."); }}>Download as Word</button>
          <button className="btn" onClick={() => void getPdf(open.title, open.body)}>Download as PDF</button>
          <button className="ghost" onClick={() => window.print()}>Print</button>
          <button className="ghost danger" onClick={remove}>Delete</button>
        </div>
        {open.body.trim().length < 40 && <p><small>Write a bit more (40+ characters) to unlock tests and questions.</small></p>}

        {teacher && (
          <section className="teacher-card">
            <h3>Share with your learners</h3>
            {open.shared ? (
              <>
                <p>Learners open this note with the link, the QR code or the code:</p>
                <ShareBox code={open.shared.code} title={open.title || "Notes"} what="notes" />
                <div className="actions">
                  <button className="btn" disabled={busy} onClick={share}>Update the shared copy</button>
                  <button className="ghost" disabled={busy} onClick={unshare}>Stop sharing</button>
                </div>
                <p><small>Changes you make above are <b>not</b> sent automatically. Press “Update the shared copy” when you are happy with them.</small></p>
              </>
            ) : (
              <>
                <p>Get a short code. Learners type it on the home page to read this note, copy it, and test themselves from it.</p>
                <PasscodeBox value={passcode} onChange={setPasscode} />
                <button className="btn" disabled={busy} onClick={share}>{busy ? "Sharing…" : "Share this note"}</button>
              </>
            )}
          </section>
        )}
        <Msg error={msg.error} ok={msg.ok} />
      </div>
      {/* Only this part is printed when you choose "Print or save as PDF". */}
      <div className="print-only"><h1>{open.title || "Untitled note"}</h1><PrintBlocks blocks={noteBlocks(open.body)} /></div>
    </Page>
  );

  /* ---------- the list ---------- */
  return (
    <Page title={teacher ? "Notes for my class" : "My notes"} onBack={onBack}
      help={teacher ? "Write or upload your notes. Edit them any time. Share them with learners using a code." : "Write notes, or turn a PDF or Word document into notes you can edit. Then test yourself on them."}>
      <HowTo steps={teacher
        ? ["Press “New note” and type or paste, upload a PDF or Word file, or press “Write a note with AI” and describe your lesson.", "Read it and fix anything you like. The AI helper can tidy it, simplify it, or add examples, objectives and a summary. It saves by itself.", "Press “Share this note” to get a code for your learners."]
        : ["Press “New note” and type or paste, upload a PDF or Word file, or press “Write a note with AI”.", "Edit it so it says what you want. The AI helper can fix your writing or organise it. It saves by itself.", "Press “Test myself” to check what you remember."]} />
      <div className="actions">
        <button className="btn" onClick={() => create()}>New note</button>
        <button className="btn" onClick={() => create("", "", true)}>✨ Write a note with AI</button>
        <button className="ghost" disabled={busy} onClick={() => file.current?.click()}>Upload a PDF or Word file</button>
        <input ref={file} type="file" hidden accept=".pdf,.docx,.txt,.md,.csv" onChange={(e) => importFile(e.target.files?.[0])} aria-label="Upload a PDF or Word file" />
      </div>
      <Msg error={msg.error} ok={msg.ok} />
      {notes.length === 0
        ? <p className="empty">You have no notes yet. Press “New note” to start.</p>
        : <ul className="rows">{notes.map((n) => (
            <li key={n.id}><button className="row" onClick={() => { setOpenId(n.id); say(); }}>
              <b>{n.title || "Untitled note"}</b>{n.shared && <span className="tag">Shared · {n.shared.code}</span>}
              <small>{when(n.updatedAt)} · {n.body.slice(0, 90).replace(/\s+/g, " ") || "Empty"}</small>
            </button></li>
          ))}</ul>}
      <p><small>Your notes are kept on this device only{teacher ? ", except the ones you choose to share" : ""}. Clearing your browser data removes them, so download the important ones.</small></p>
    </Page>
  );
}
