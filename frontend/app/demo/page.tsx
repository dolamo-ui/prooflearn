import Link from "next/link";

// BACKUP WALKTHROUGH. Fixed sample data, no AI, works offline.
// Use it only if the live demo fails, and say so: "this is a recorded sample run".
export const metadata = { title: "ProofLearn backup demo" };

const trace = [
  ["plan", "Read the uploaded past paper (Spreadsheet skills, 40 marks). Plan: 3 topics, 8 questions."],
  ["tool", "Tool: read PDF, extracted 1 840 characters of exam text."],
  ["tool", "Drafted 8 questions from the memo."],
  ["critic", "Checker reviewing every question for fairness and correctness…"],
  ["fix", "Question 3: The memo accepts two answers but the question allowed only one. Fixed."],
  ["critic", "Question 6: Two options were both correct. Removed."],
  ["critic", "Checker: 2 questions changed. All 7 remaining questions approved."],
];

export default function Demo() {
  return (
    <main className="app">
      <header className="top"><div><h1>ProofLearn</h1><p>Backup walkthrough</p></div></header>
      <p className="warn"><b>Backup walkthrough.</b> This page shows a recorded sample run with fixed numbers. It does not call the AI. <Link href="/">Back to the live app</Link></p>
      <div className="shell">
      <div className="cover" aria-hidden="true" />
      <section className="paper">
      <h2>Teach it, test it, prove it</h2>

      <h3>1. Teacher uploads a past paper, the agent plans</h3>
      <ol>{trace.map(([k, t], i) => <li key={i}><b>{k}:</b> {t}</li>)}</ol>

      <section className="selfcheck">
        <h3>Agent self-check</h3>
        <div className="tiles">
          <div><b>8</b><span>questions drafted</span></div>
          <div><b>2</b><span>problems found</span></div>
          <div><b>1</b><span>fixed</span></div>
          <div><b>1</b><span>removed</span></div>
          <div className="good"><b>7</b><span>approved for you</span></div>
        </div>
        <small>A second AI pass checked the first one’s work before the learner saw it.</small>
      </section>

      <h3>2. Learner takes the test, then is re-taught</h3>
      <p>Weak on <b>Absolute references</b> and <b>VLOOKUP</b>. The agent explained them a second way and made fresh questions.</p>

      <section className="proof">
        <h3>Proof of learning</h3>
        <div className="proofrow">
          <div><b>40%</b><span>first test</span></div>
          <div className="arrow">→</div>
          <div className="good"><b>80%</b><span>after re-teaching</span></div>
          <div className="gain"><b>+40</b><span>points</span></div>
        </div>
      </section>

      <h3>3. Teacher sees what to fix</h3>
      <section className="insight">
        <h3>Teacher insight</h3>
        <p><b>60% of the class did not meet the goal on “VLOOKUP”.</b> A 10-minute reteach plan: show one lookup table on screen (3 min), learners fix a broken formula in pairs (5 min), exit question (2 min).</p>
      </section>

      <h3>4. Security, in 10 seconds</h3>
      <p>If a learner edits the answer key in the browser, the server refuses to mark it: “This question was changed and cannot be marked.”</p>
      </section>
      </div>
    </main>
  );
}
