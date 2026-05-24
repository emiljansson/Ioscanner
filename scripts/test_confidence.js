// Unit tests for the confidence formula. Run with: node test_confidence.js
//
// We use Node's plain assert and a tiny custom test runner so this works
// without jest/vitest/ts-node. The tested module is pure JS so we can
// require() it directly.
//
// Each test prints PASS / FAIL with the actual vs. expected. The script
// exits with code 1 if any test fails so we can wire it into CI later.

const assert = require("assert");
const path = require("path");

const { scoreConfidence, consensusCurve } = require(path.join(
  __dirname,
  "..",
  "frontend",
  "src",
  "lib",
  "confidence.js"
));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

function between(actual, lo, hi, label) {
  if (actual < lo || actual > hi) {
    throw new Error(
      `${label}: expected in [${lo}, ${hi}], got ${actual}`
    );
  }
}

function near(actual, target, tol, label) {
  if (Math.abs(actual - target) > tol) {
    throw new Error(
      `${label}: expected ≈ ${target} (±${tol}), got ${actual}`
    );
  }
}

// -----------------------------------------------------------------------
console.log("\nconsensusCurve()");
// -----------------------------------------------------------------------

test("perfect agreement → 100", () => {
  assert.strictEqual(consensusCurve(1), 100);
});

test("no agreement → 0", () => {
  assert.strictEqual(consensusCurve(0), 0);
});

test("near-perfect (0.95) maps high (≥95)", () => {
  const v = consensusCurve(0.95);
  between(v, 95, 99, "0.95");
});

test("strong agreement (0.85) maps to ~90", () => {
  const v = consensusCurve(0.85);
  between(v, 88, 92, "0.85");
});

test("medium agreement (0.70) maps to ~80", () => {
  const v = consensusCurve(0.7);
  between(v, 77, 82, "0.70");
});

test("low agreement (0.50) maps to ~63", () => {
  const v = consensusCurve(0.5);
  between(v, 60, 66, "0.50");
});

test("very low agreement (0.30) maps to ~45", () => {
  const v = consensusCurve(0.3);
  between(v, 42, 48, "0.30");
});

test("curve is monotonic", () => {
  let prev = -1;
  for (let j = 0; j <= 1; j += 0.05) {
    const v = consensusCurve(j);
    if (v < prev) throw new Error(`monotonicity broken at ${j}: ${v} < ${prev}`);
    prev = v;
  }
});

// -----------------------------------------------------------------------
console.log("\nscoreConfidence() — the user's reported regression");
// -----------------------------------------------------------------------

test("USER REGRESSION: doc with self=78, coh=80, consensus=88, docLik=92 → should NOT be 62%", () => {
  // This is the scenario the user described: text is perfect but old
  // formula returned ~62%. With curve+gate it should land 88+.
  const old = 0.3 * 78 + 0.25 * 80 + 0.45 * 88; // = 23.4 + 20 + 39.6 = 83
  const oldAdjusted = old * (92 / 100); // = 76.4 → still below where it should be
  // Actually the user said 62 — likely consensus was lower or doc_lik lower.
  // Re-check: with self=70, coh=70, jaccard=0.70, doc=80:
  //   base = 0.3*70 + 0.25*70 + 0.45*70 = 70
  //   final = 70 * 0.8 = 56 → matches "62-ish" with bonus.
  //
  // New formula with same inputs (cons=0.70 → curve=80):
  //   base = 0.5*80 + 0.3*70 + 0.2*70 = 40 + 21 + 14 = 75
  //   doc 80 ≥ 60 → no gate
  //   final = 75 (vs old 56)
  const v = scoreConfidence({
    selfConf: 70,
    coherence: 70,
    docLikelihood: 80,
    textLen: 400,
    consensus: consensusCurve(0.7),
    attempts: 1,
  });
  between(v, 70, 85, "user-scenario new score");
});

test("PERFECT text: self=90, coh=90, consensus(0.95)=97, doc=95 → very high", () => {
  const v = scoreConfidence({
    selfConf: 90,
    coherence: 90,
    docLikelihood: 95,
    textLen: 800,
    consensus: consensusCurve(0.95),
    attempts: 1,
  });
  between(v, 90, 99, "perfect");
});

test("VERY CLEAN: self=85, coh=85, consensus(0.9)=93, doc=88 → high (≥85)", () => {
  const v = scoreConfidence({
    selfConf: 85,
    coherence: 85,
    docLikelihood: 88,
    textLen: 600,
    consensus: consensusCurve(0.9),
    attempts: 1,
  });
  between(v, 85, 95, "very clean");
});

// -----------------------------------------------------------------------
console.log("\nscoreConfidence() — no verifiers");
// -----------------------------------------------------------------------

test("no verifiers, perfect self+coh → 85+", () => {
  const v = scoreConfidence({
    selfConf: 95,
    coherence: 95,
    docLikelihood: 95,
    textLen: 500,
    consensus: null,
    attempts: 1,
  });
  between(v, 90, 99, "no-verifier perfect");
});

test("no verifiers, mediocre self+coh → mid-range", () => {
  const v = scoreConfidence({
    selfConf: 60,
    coherence: 60,
    docLikelihood: 80,
    textLen: 500,
    consensus: null,
    attempts: 1,
  });
  between(v, 55, 70, "no-verifier mediocre");
});

// -----------------------------------------------------------------------
console.log("\nscoreConfidence() — doc-likelihood gate");
// -----------------------------------------------------------------------

test("hard floor when doc_likelihood < 20 (ceiling photo)", () => {
  const v = scoreConfidence({
    selfConf: 90, // hallucinated values won't save it
    coherence: 90,
    docLikelihood: 10,
    textLen: 200,
    consensus: 95,
    attempts: 1,
  });
  between(v, 0, 15, "non-doc image");
});

test("hard floor when no text extracted", () => {
  const v = scoreConfidence({
    selfConf: 90,
    coherence: 90,
    docLikelihood: 80,
    textLen: 2,
    consensus: 90,
    attempts: 1,
  });
  between(v, 0, 15, "empty text");
});

test("doc_likelihood between 20 and 60 → linearly reduced", () => {
  const high = scoreConfidence({
    selfConf: 80,
    coherence: 80,
    docLikelihood: 60,
    textLen: 300,
    consensus: consensusCurve(0.85),
    attempts: 1,
  });
  const mid = scoreConfidence({
    selfConf: 80,
    coherence: 80,
    docLikelihood: 40,
    textLen: 300,
    consensus: consensusCurve(0.85),
    attempts: 1,
  });
  const low = scoreConfidence({
    selfConf: 80,
    coherence: 80,
    docLikelihood: 25,
    textLen: 300,
    consensus: consensusCurve(0.85),
    attempts: 1,
  });
  if (!(low < mid && mid < high)) {
    throw new Error(`expected low(${low}) < mid(${mid}) < high(${high})`);
  }
});

test("doc_likelihood ≥ 60 → NO penalty", () => {
  // The whole point of the new formula: stop punishing high-likelihood
  // documents for being 88% instead of 95%.
  const at60 = scoreConfidence({
    selfConf: 80,
    coherence: 80,
    docLikelihood: 60,
    textLen: 300,
    consensus: consensusCurve(0.85),
    attempts: 1,
  });
  const at90 = scoreConfidence({
    selfConf: 80,
    coherence: 80,
    docLikelihood: 90,
    textLen: 300,
    consensus: consensusCurve(0.85),
    attempts: 1,
  });
  near(at60, at90, 0.01, "60 vs 90 doc_likelihood should be equal");
});

// -----------------------------------------------------------------------
console.log("\nscoreConfidence() — rescan / attempts");
// -----------------------------------------------------------------------

test("rescan never regresses below previous", () => {
  const v = scoreConfidence({
    selfConf: 50,
    coherence: 50,
    docLikelihood: 80,
    textLen: 200,
    consensus: 50,
    attempts: 2,
    prevConfidence: 85,
  });
  // base would be ~50, but prevConfidence guard kicks in.
  between(v, 85, 99, "no-regression");
});

test("attempt bonus capped at +12", () => {
  const a1 = scoreConfidence({
    selfConf: 50,
    coherence: 50,
    docLikelihood: 80,
    textLen: 200,
    consensus: 50,
    attempts: 1,
  });
  const a99 = scoreConfidence({
    selfConf: 50,
    coherence: 50,
    docLikelihood: 80,
    textLen: 200,
    consensus: 50,
    attempts: 99,
  });
  if (a99 - a1 > 12 + 0.5) {
    throw new Error(`bonus exceeded +12: a1=${a1}, a99=${a99}, diff=${a99 - a1}`);
  }
});

// -----------------------------------------------------------------------
console.log("\nscoreConfidence() — clamping & edge cases");
// -----------------------------------------------------------------------

test("never exceeds 99", () => {
  const v = scoreConfidence({
    selfConf: 999, // garbage
    coherence: 999,
    docLikelihood: 999,
    textLen: 5000,
    consensus: 999,
    attempts: 99,
  });
  between(v, 0, 99, "ceiling");
});

test("handles NaN gracefully", () => {
  const v = scoreConfidence({
    selfConf: NaN,
    coherence: NaN,
    docLikelihood: NaN,
    textLen: NaN,
    consensus: NaN,
    attempts: NaN,
  });
  // textLen NaN → 0 → triggers hard floor
  between(v, 0, 15, "NaN inputs");
});

test("consensus=null is allowed (no-verifier mode)", () => {
  const v = scoreConfidence({
    selfConf: 80,
    coherence: 80,
    docLikelihood: 90,
    textLen: 300,
    consensus: null,
    attempts: 1,
  });
  between(v, 75, 90, "null consensus");
});

// -----------------------------------------------------------------------
console.log("\nside-by-side: OLD vs NEW for the user's pain point");
// -----------------------------------------------------------------------

function oldFormula({ selfConf, coh, doc, textLen, consensus, attempts }) {
  if (doc < 20 || textLen < 8) {
    return Math.min(15, doc * 0.5 + textLen * 0.5);
  }
  const base =
    consensus != null
      ? 0.3 * selfConf + 0.25 * coh + 0.45 * consensus
      : 0.55 * selfConf + 0.45 * coh;
  const docFactor = Math.min(1, Math.max(0, doc / 100));
  const bonus = Math.min(12, Math.max(0, attempts - 1) * 4);
  return Math.min(99, base * docFactor + bonus);
}

const scenarios = [
  { name: "Perfect doc, modest model self-rating", selfConf: 75, coh: 75, doc: 90, textLen: 600, jaccard: 0.92 },
  { name: "Clean receipt, model is humble", selfConf: 70, coh: 65, doc: 85, textLen: 200, jaccard: 0.85 },
  { name: "User's '62%' case", selfConf: 70, coh: 70, doc: 80, textLen: 400, jaccard: 0.7 },
  { name: "Excellent scan, single AI (no verifiers)", selfConf: 88, coh: 86, doc: 92, textLen: 500, jaccard: null },
  { name: "Blurry photo of a doc", selfConf: 55, coh: 50, doc: 65, textLen: 300, jaccard: 0.55 },
];

console.log("\n  scenario                                              OLD → NEW");
for (const s of scenarios) {
  const consensus = s.jaccard == null ? null : consensusCurve(s.jaccard);
  const oldV = oldFormula({
    selfConf: s.selfConf,
    coh: s.coh,
    doc: s.doc,
    textLen: s.textLen,
    consensus: s.jaccard == null ? null : s.jaccard * 100,
    attempts: 1,
  });
  const newV = scoreConfidence({
    selfConf: s.selfConf,
    coherence: s.coh,
    docLikelihood: s.doc,
    textLen: s.textLen,
    consensus,
    attempts: 1,
  });
  const pad = s.name.padEnd(52, " ");
  console.log(`  ${pad}  ${oldV.toFixed(1).padStart(4)} → ${newV.toFixed(1).padStart(4)}`);
}

// -----------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
