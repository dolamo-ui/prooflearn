"use client";
import type { Finding } from "../lib/agent";

/* Additive demo helpers: self-check card, proof-of-learning card, teacher insight, sample data. */

export const SAMPLE_PAPER = `SAMPLE PAST PAPER (made up for the demo): Spreadsheet skills, 40 marks

QUESTION 1: Formulas
1.1 Which formula adds the values in cells B2 to B10? (2)
1.2 Cell C2 contains =B2*5%. It is copied down to C3. What does C3 contain? (2)
1.3 Explain the difference between a relative reference (A1) and an absolute reference ($A$1). (4)
1.4 Why would you write =B2*$F$1 when F1 holds the VAT rate? (3)

QUESTION 2: Functions
2.1 Write a formula that shows "Pass" if D2 is 50 or more, otherwise "Fail". (3)
2.2 What does VLOOKUP(A2, F2:G20, 2, FALSE) do? Explain each part. (6)
2.3 Why is the last argument FALSE and not TRUE when looking up a product code? (3)

QUESTION 3: Charts
3.1 Which chart type shows how each part contributes to a whole? (2)
3.2 Name three things every chart should have so a reader can understand it. (3)

MEMO
1.1 =SUM(B2:B10)
1.2 =B3*5% (the row number changes, the 5% stays)
1.3 A relative reference changes when copied; an absolute reference ($) stays fixed.
1.4 So the VAT cell does not move when the formula is copied down.
2.1 =IF(D2>=50,"Pass","Fail")
2.2 It looks up the value in A2 in the first column of F2:G20 and returns the value from the 2nd column; FALSE means an exact match is required.
2.3 FALSE finds an exact match; TRUE can return the wrong product.
3.1 Pie chart
3.2 A title, labelled axes (or labels) and a legend.
`;

/* ---------- 1. Agent self-check (the autonomy moment) ---------- */
export function SelfCheckCard({ findings }: { findings: Finding[] }) {
  if (!findings.length) return null;
  const drafted = findings.length;
  const fixed = findings.filter((f) => f.action === "fixed");
  const removed = findings.filter((f) => f.action === "removed");
  const approved = drafted - removed.length;
  return (
    <section className="selfcheck" aria-label="Agent self-check">
      <h3>Agent self-check</h3>
      <div className="tiles">
        <div><b>{drafted}</b><span>questions drafted</span></div>
        <div><b>{fixed.length + removed.length}</b><span>problems found</span></div>
        <div><b>{fixed.length}</b><span>fixed</span></div>
        <div><b>{removed.length}</b><span>removed</span></div>
        <div className="good"><b>{approved}</b><span>approved for you</span></div>
      </div>
      {fixed.length + removed.length > 0 && (
        <ul>
          {[...fixed, ...removed].map((f) => (
            <li key={f.id}><b>{f.action === "fixed" ? "Fixed" : "Removed"}:</b> {f.problem}</li>
          ))}
        </ul>
      )}
      <small>A second AI pass checked the first one’s work before you saw it.</small>
    </section>
  );
}

/* ---------- 2. Proof of learning: before and after number ---------- */
export function ProofCard({ topics, first, latest, retested }: { topics: string[]; first: Record<string, number>; latest: Record<string, number>; retested: boolean }) {
  const used = topics.filter((t) => first[t] !== undefined);
  if (!used.length) return null;
  const avg = (get: (t: string) => number) => Math.round(used.reduce((s, t) => s + get(t), 0) / used.length);
  const before = avg((t) => first[t]);
  const after = avg((t) => latest[t] ?? first[t]);
  return (
    <section className="proof" aria-label="Proof of learning">
      <h3>Proof of learning</h3>
      <div className="proofrow">
        <div><b>{before}%</b><span>first test</span></div>
        {retested && <><div className="arrow" aria-hidden="true">→</div><div className="good"><b>{after}%</b><span>after re-teaching</span></div><div className="gain"><b>{after >= before ? "+" : ""}{after - before}</b><span>points</span></div></>}
      </div>
      {!retested && <small>Take the re-teach and retest to see your improvement here.</small>}
    </section>
  );
}

/* ---------- 3. Teacher insight headline ---------- */
export function TeacherInsight({ results }: { results: { topic: string; assessed: number; met: number; percent: number }[] }) {
  if (!results.length) return null;
  const worst = [...results].sort((a, b) => a.percent - b.percent)[0];
  const missed = 100 - worst.percent;
  const low = results.filter((r) => r.percent < 70).length;
  return (
    <section className="insight" aria-label="Teacher insight">
      <h3>Teacher insight</h3>
      <p><b>{missed}% of the class did not meet the goal on “{worst.topic}”.</b> {low > 1 ? `${low} topics are below 70%. ` : ""}A 10-minute reteach plan is ready below.</p>
    </section>
  );
}

/* Sample class numbers so a teacher can see the insight in one click (clearly a sample). */
export function sampleClassCounts(topics: string[]): Record<string, { assessed: string; met: string }> {
  const mets = [9, 21, 12, 24, 15];
  return Object.fromEntries(topics.map((t, i) => [t, { assessed: "30", met: String(mets[i % mets.length]) }]));
}
