"use client";
import { useState } from "react";
import { api, type LocalNote } from "../lib/client";
import { HowTo, Msg, NotePicker, Page } from "./ui";

export default function AskNotes({ note, onBack }: { note?: LocalNote | null; onBack: () => void }) {
  const [noteId, setNoteId] = useState(note?.id || "");
  const [text, setText] = useState(note?.body || "");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [r, setR] = useState<{ found: boolean; answer: string; sources: string[] } | null>(null);

  const ask = async () => {
    setError(""); setR(null);
    if (text.trim().length < 40) return setError("Choose a note with a little more text first.");
    if (question.trim().length < 3) return setError("Type your question first.");
    setBusy(true);
    try { setR(await api("/api/study", { action: "ask", notes: text, question })); } catch (e: any) { setError(e.message); }
    setBusy(false);
  };

  return (
    <Page title="Ask my notes" onBack={onBack} help="Ask a question. The AI looks only inside your note, and shows you where the answer is. If your note does not say, it will tell you.">
      <HowTo steps={["Choose a note.", "Type your question in your own words.", "Read the answer and the part of your note it came from."]} />
      <NotePicker role="learner" value={noteId} onChange={(id, n) => { setNoteId(id); setText(n?.body || ""); setR(null); }} />
      <label className="answer-field"><span>Your question</span>
        <input value={question} maxLength={600} placeholder="For example: What is chlorophyll?" onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !busy && ask()} />
      </label>
      <button className="btn" disabled={busy || !text} onClick={ask}>{busy ? "Looking in your note…" : "Ask"}</button>
      <Msg error={error} />
      {r && (
        <section className={"review " + (r.found ? "right" : "wrong")}>
          {!r.found && <p><b>Your note does not seem to cover this.</b></p>}
          <p>{r.answer}</p>
          {r.sources.map((s, i) => <blockquote className="ref" key={i}><small>From your note:</small> {s}{s.length >= 300 ? "…" : ""}</blockquote>)}
        </section>
      )}
    </Page>
  );
}
