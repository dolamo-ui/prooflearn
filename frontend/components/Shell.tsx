"use client";
import { useEffect, useState } from "react";
import type { LocalNote } from "../lib/client";
import { getPasscode, setPasscode as storePasscode } from "../lib/client";
import { codeFromLink } from "../lib/share";
import { APP_NAME, TAGLINE } from "../lib/agent";
import App from "./App";
import AskNotes from "./AskNotes";
import Coach from "./Coach";
import Colleague from "./Colleague";
import JoinCode from "./JoinCode";
import NotesLab from "./NotesLab";
import PracticeTest from "./PracticeTest";
import WorkStudio from "./WorkStudio";
import { Card, HowTo, Page, WaitBanner } from "./ui";

type View =
  | { n: "home" } | { n: "learner" } | { n: "teacher" }
  | { n: "notes"; role: "learner" | "teacher"; open?: string }
  | { n: "test"; note?: LocalNote | null } | { n: "ask"; note?: LocalNote | null }
  | { n: "join"; code?: string } | { n: "work"; note?: LocalNote | null }
  | { n: "learn" } | { n: "plan" } | { n: "colleague" } | { n: "coach" } | { n: "legacy" };

export default function Shell() {
  const [view, setView] = useState<View>({ n: "home" });
  const [code, setCode] = useState("");
  const [passcode, setPass] = useState("");
  const [ai, setAi] = useState<"checking" | "on" | "off">("checking");

  useEffect(() => {
    setPass(getPasscode());
    const linked = codeFromLink();                       // opened from a share link or QR code: go straight to the work
    if (linked) setView({ n: "join", code: linked });
    const h = window.location.hash;
    if (h.startsWith("#assignment=") || h.startsWith("#submission=")) setView({ n: "legacy" }); // old demo links still open
    fetch("/api/agent").then((r) => r.json()).then((d) => setAi(d.live ? "on" : "off")).catch(() => setAi("off"));
  }, []);
  const setPasscode = (v: string) => { setPass(v); storePasscode(v); };
  const go = (v: View) => { setView(v); window.scrollTo({ top: 0 }); };
  const home = () => go({ n: "home" });

  // The existing course builder and lesson planner bring their own full-page layout.
  if (view.n === "learn" || view.n === "plan" || view.n === "legacy") {
    return <App embedded startTab={view.n === "plan" ? "teacher" : "learner"} onHome={home} />;
  }

  const body = (() => {
    switch (view.n) {
      case "learner": return (
        <Page title="Learner" onBack={home} backLabel="Home" help="Pick what you want to do. If you are new, start at number 1.">
          <div className="hub">
            <Card n={1} title="My notes" text="Write notes, or turn a PDF or Word file into notes you can edit." onClick={() => go({ n: "notes", role: "learner" })} />
            <Card n={2} title="Test myself" text="Practice questions made from your own notes, with the answer explained." onClick={() => go({ n: "test" })} />
            <Card n={3} title="Ask my notes" text="Ask a question. See exactly where in your notes the answer is." onClick={() => go({ n: "ask" })} />
            <Card n={4} title="Open my teacher’s work" text="Type a code to read your teacher’s notes or do their test." onClick={() => go({ n: "join" })} />
            <Card n={5} title="Learn something new" text="Tell the AI a topic. Get short lessons, a test, and extra help where you are stuck." onClick={() => go({ n: "learn" })} />
            <Card n={6} title="My learning coach" badge="New" text="Say what you want to learn. A coach decides what to teach and when to test you, and only says you learned it when your marked answers prove it." onClick={() => go({ n: "coach" })} />
          </div>
        </Page>);
      case "teacher": return (
        <Page title="Teacher" onBack={home} backLabel="Home" help="Do the steps in order the first time: notes, then a test, then look at the results.">
          <div className="hub">
            <Card n={1} title="Notes for my class" text="Write or upload your notes. Edit them. Share them with learners using a code." onClick={() => go({ n: "notes", role: "teacher" })} />
            <Card n={2} title="Tests and classwork" text="AI drafts questions from your notes. You edit them, share a code, and see the results." onClick={() => go({ n: "work" })} />
            <Card n={3} title="Plan a lesson and reteach" text="A timed lesson plan, and a 10-minute reteach for topics your class found hard." onClick={() => go({ n: "plan" })} />
            <Card n={4} title="Digital colleague" badge="New" text="Give it a goal. It decides the steps itself: reads your notes, builds lessons and a test, checks its own work, and reports back." onClick={() => go({ n: "colleague" })} />
          </div>
        </Page>);
      case "notes": return (
        <NotesLab key={view.role} role={view.role} passcode={passcode} setPasscode={setPasscode} startWith={view.open}
          onBack={() => go({ n: view.role })}
          onTest={(n) => go(view.role === "teacher" ? { n: "work", note: n } : { n: "test", note: n })}
          onAsk={(n) => go({ n: "ask", note: n })} />);
      case "test": return <PracticeTest note={view.note} onBack={() => go({ n: "learner" })} />;
      case "ask": return <AskNotes note={view.note} onBack={() => go({ n: "learner" })} />;
      case "join": return <JoinCode initialCode={view.code} onBack={home}
        onSaved={(n, thenTest) => go(thenTest ? { n: "test", note: n } : { n: "notes", role: "learner", open: n.id })} />;
      case "coach": return <Coach onBack={() => go({ n: "learner" })} />;
      case "colleague": return <Colleague passcode={passcode} setPasscode={setPasscode} onBack={() => go({ n: "teacher" })} />;
      case "work": return <WorkStudio passcode={passcode} setPasscode={setPasscode} startNote={view.note} onBack={() => go({ n: "teacher" })} />;
      default: return (
        <Page title="What would you like to do?" help="Choose the one that sounds like you. You can switch at any time.">
          <div className="hub two">
            <Card title="I am a learner" text="Study, test yourself, and open work from your teacher." onClick={() => go({ n: "learner" })} />
            <Card title="I am a teacher" text="Make notes and tests for your class, and see how they did." onClick={() => go({ n: "teacher" })} />
          </div>
          <section className="teacher-card codecard">
            <h3>Have a code from your teacher?</h3>
            <p>Type it here. You do not need an account.</p>
            <div className="codeline">
              <input className="codebox" aria-label="Code from your teacher" value={code} maxLength={12} placeholder="NABC-D234" autoComplete="off" autoCapitalize="characters"
                onChange={(e) => setCode(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === "Enter" && code.trim() && go({ n: "join", code })} />
              <button className="btn" disabled={!code.trim()} onClick={() => go({ n: "join", code })}>Open</button>
            </div>
          </section>
          <HowTo steps={["Learners write or upload notes, then test themselves on them.", "Teachers share notes and tests with a short code.", "Learners type the code. Teachers see who needs help."]} />
          <p><small>Privacy: your notes stay on this device unless a teacher chooses to share them. When you press an AI button, the text you chose is sent to the AI service to write or mark questions. Please do not put private details about real people in your notes.</small></p>
        </Page>);
    }
  })();

  return (
    <div className="app">
      <header className="top">
        <div><h1>{APP_NAME}</h1><p>{TAGLINE}</p></div>
        <nav>
          {ai !== "checking" && <span className={"pill " + (ai === "on" ? "connected" : "unavailable")}>{ai === "on" ? "● AI is on" : "○ AI is off"}</span>}
          {view.n !== "home" && <button className="ghost" onClick={home}>Home</button>}
        </nav>
      </header>
      {ai === "off" && <p className="warn"><b>The AI is not switched on yet.</b> Notes still work, but tests and questions need it. Ask whoever set up this app to add the Groq key (see README, step 3).</p>}
      <WaitBanner />
      <div className="shell"><div className="cover" aria-hidden="true" /><main className="paper" key={view.n}>{body}</main></div>
    </div>
  );
}
