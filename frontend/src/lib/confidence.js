// Pure-JS confidence math, isolated from ai.ts so it can be unit-tested
// with plain Node (no TS / no RN dependencies). Imported back by ai.ts.
//
// HIGH-LEVEL CHANGES vs. the old formula:
//   1. consensus uses an S-shaped curve so "almost-perfect agreement"
//      Jaccard ≈ 0.85 maps to ~90% instead of literally 85%.
//   2. doc_likelihood is a GATE, not a multiplier:
//        < 20  → hard-cap to ≤15  (probably not a document at all)
//        20-59 → linearly scale (uncertain)
//        ≥ 60  → no penalty (looks like a document, trust the other signals)
//   3. New weights with verifiers favour cross-model consensus
//      (it's the only objective signal we have):
//        0.50 * consensus + 0.30 * self_conf + 0.20 * coherence
//      Without verifiers we keep the model's own self-rating:
//        0.60 * self_conf + 0.40 * coherence

const CONSENSUS_EXPONENT = 0.65;

/** Map a raw Jaccard ratio (0–1) to a 0–100 consensus score with a curve
 *  that rewards near-agreement. */
function consensusCurve(jaccardZeroToOne) {
  if (!isFinite(jaccardZeroToOne) || jaccardZeroToOne <= 0) return 0;
  if (jaccardZeroToOne >= 1) return 100;
  return Math.pow(jaccardZeroToOne, CONSENSUS_EXPONENT) * 100;
}

/** Compute the final 0–99 confidence percent from the model's signals.
 *
 *  Inputs (all 0–100 except textLen and attempts):
 *    selfConf       — model's own self-rating
 *    coherence      — model's coherence-score
 *    docLikelihood  — model's "is this even a document?" score
 *    textLen        — length of the extracted plain text (no whitespace)
 *    consensusZeroTo100 — null if no verifiers ran, else the SCALED consensus
 *                         (already passed through consensusCurve) on 0–100
 *    attempts       — re-scan attempt count (1 = first try)
 *    prevConfidence — confidence of the previous attempt (rescan only); we
 *                     guarantee `confidence >= prevConfidence` so the user
 *                     never sees a regression after a re-photo.
 */
function scoreConfidence(opts) {
  const selfConf = clamp01_100(opts.selfConf);
  const coherence = clamp01_100(opts.coherence);
  const docLikelihood = clamp01_100(opts.docLikelihood);
  const textLen = Math.max(0, opts.textLen | 0);
  const consensus =
    opts.consensus == null || !isFinite(opts.consensus) ? null : clamp01_100(opts.consensus);
  const attempts = Math.max(1, opts.attempts | 0 || 1);
  const prevConfidence = clamp01_100(opts.prevConfidence ?? 0);

  // Hard guard: not a document, or no text → collapse confidence.
  if (docLikelihood < 20 || textLen < 8) {
    const collapsed = Math.min(15, docLikelihood * 0.5 + textLen * 0.5);
    return round1(collapsed);
  }

  // Weighted base score.
  const base =
    consensus != null
      ? 0.5 * consensus + 0.3 * selfConf + 0.2 * coherence
      : 0.6 * selfConf + 0.4 * coherence;

  // Doc-likelihood gate. Only kicks in if the model itself is unsure
  // it's even a document.
  let gated;
  if (docLikelihood >= 60) {
    gated = base;
  } else {
    // Linear ramp 20–60 → 0.33–1.0
    const factor = Math.max(0, Math.min(1, (docLikelihood - 20) / 40));
    // Don't punish below 33% even at the floor of the range so a strong
    // base reading (high consensus + high self) still shows as medium-low.
    gated = base * (0.33 + 0.67 * factor);
  }

  // Re-scan bonus: each retake adds a little reward.
  const bonus = Math.min(12, Math.max(0, attempts - 1) * 4);

  let final = Math.min(99, gated + bonus);

  // Never regress below the previous attempt's score on a rescan.
  if (final < prevConfidence) {
    final = Math.min(99, prevConfidence + 2);
  }

  return round1(final);
}

function clamp01_100(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

module.exports = {
  consensusCurve,
  scoreConfidence,
};
