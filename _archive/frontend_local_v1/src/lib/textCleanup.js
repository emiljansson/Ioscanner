// Pure-JS post-OCR text cleanup. No RN deps so it can be unit-tested.
//
// Goal: take messy OCR output (column-wrapped, hyphenated, mixed headings
// and body) and produce a clean markdown-style structure that:
//   • Has detected headings wrapped in **...** on their own line.
//   • Preserves list items (-, •, 1., a), …) each on their own line.
//   • Reflows paragraph body so each paragraph is ONE long logical line.
//     This is what makes the text "fill an A4 page naturally" when pasted
//     into Word, since the word processor handles the wrapping.
//   • Keeps blank lines as paragraph boundaries.
//
// We are deliberately conservative about heading detection: false-positive
// headings break paragraph flow much worse than missed headings, so we
// only mark a line as a heading when several signals point to it.

const LIST_PREFIX_RE =
  /^\s*([-•◦▪–*]\s+|\d+[.)]\s+|[a-zA-Z][.)]\s+|[ivxIVX]+[.)]\s+|□\s+|☐\s+|✓\s+)/;
const MD_HEADING_RE = /^\s*\*\*(.+?)\*\*\s*$/;
const SENTENCE_END_RE = /[.!?:;,)…»”"]\s*$/;
// Words that strongly signal a section header at start of line.
const SECTION_KEYWORDS =
  /^(chapter|avdelning|avsnitt|section|kapitel|del|paragraf|§|appendix|bilaga|index)\b/i;

function isMostlyUppercase(line) {
  const letters = line.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, "");
  if (letters.length < 2) return false;
  let upper = 0;
  let lower = 0;
  for (const ch of letters) {
    if (ch === ch.toUpperCase() && ch !== ch.toLowerCase()) upper++;
    else if (ch === ch.toLowerCase() && ch !== ch.toUpperCase()) lower++;
  }
  // "Mostly uppercase" = no lowercase or at most one lowercase letter (allow
  // typos / "ÅÄÖ vs åäö" weirdness from OCR).
  return upper >= 2 && lower <= 1;
}

function isTitleCase(line) {
  const stripped = line.replace(/^\s*[\d.)§]+\s*/, "");
  const words = stripped.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0 || words.length > 8) return false;
  // Allow common lowercase joiner words ("and", "of", "och", "av", "i").
  const joiners = new Set([
    "a", "an", "the", "and", "or", "of", "in", "on", "to", "for", "by",
    "och", "eller", "av", "i", "på", "för", "till", "med", "från",
  ]);
  let titleHits = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (joiners.has(w.toLowerCase()) && i !== 0) continue;
    if (!/^[A-Za-zÀ-ÖØ-öø-ÿ]/.test(w[0])) continue;
    const first = w[0];
    if (first === first.toUpperCase() && first !== first.toLowerCase()) {
      titleHits++;
    } else {
      return false;
    }
  }
  return titleHits >= 1;
}

function looksLikeHeading(line, prevBlank, nextBlank) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (LIST_PREFIX_RE.test(line)) return false;
  if (trimmed.length > 80) return false;
  // Existing markdown heading is handled elsewhere.
  if (MD_HEADING_RE.test(trimmed)) return false;
  if (SENTENCE_END_RE.test(trimmed)) return false;

  // Strong signals (work even without surrounding blank lines)
  if (SECTION_KEYWORDS.test(trimmed) && trimmed.length < 60) return true;
  if (isMostlyUppercase(trimmed) && trimmed.length < 60) return true;

  // Softer signal — needs context support (blank lines around it)
  if ((prevBlank || nextBlank) && isTitleCase(trimmed) && trimmed.length < 60) {
    return true;
  }
  return false;
}

function rejoinHyphenated(text) {
  // Rejoin word-break hyphens: "vibra-\ntion" -> "vibration"
  // We require: letter, hyphen, optional whitespace, newline, letter on next
  // line — and we only rejoin when the second part starts lowercase so we
  // don't accidentally merge a proper name across a line.
  return text.replace(/([\p{L}])-\s*\n\s*([\p{Ll}])/gu, "$1$2");
}

/**
 * Clean up OCR output into reflowable markdown.
 *
 * @param {string} text  Raw OCR text. May already contain **...** headings.
 * @returns {string}     Cleaned markdown with one paragraph per logical block.
 */
function cleanupOcrText(text) {
  if (typeof text !== "string" || !text.trim()) return "";

  // 1. Normalise newlines and trim per-line whitespace.
  let s = text.replace(/\r\n?/g, "\n");
  // 2. Rejoin hyphenated word breaks BEFORE we tokenise into lines.
  s = rejoinHyphenated(s);
  const lines = s.split("\n").map((l) => l.replace(/[ \t]+$/, ""));

  // 3. Classify each line: blank / heading / list / body
  const TYPE_BLANK = "blank";
  const TYPE_HEADING = "heading";
  const TYPE_LIST = "list";
  const TYPE_BODY = "body";

  const classified = lines.map((line) => {
    if (!line.trim()) return { type: TYPE_BLANK, text: "" };
    const md = line.match(MD_HEADING_RE);
    if (md) return { type: TYPE_HEADING, text: md[1].trim() };
    if (LIST_PREFIX_RE.test(line)) return { type: TYPE_LIST, text: line.trim() };
    return { type: TYPE_BODY, text: line.trim() };
  });

  // 4. Promote body lines that look like headings (using neighbour context).
  for (let i = 0; i < classified.length; i++) {
    const c = classified[i];
    if (c.type !== TYPE_BODY) continue;
    const prevBlank = i === 0 || classified[i - 1].type === TYPE_BLANK;
    const nextBlank =
      i === classified.length - 1 || classified[i + 1].type === TYPE_BLANK;
    if (looksLikeHeading(c.text, prevBlank, nextBlank)) {
      classified[i] = { type: TYPE_HEADING, text: c.text };
    }
  }

  // 5. Walk through and build output blocks. Body lines get joined into a
  //    single space-separated paragraph; everything else stays on its own
  //    line.
  const blocks = [];
  let bodyBuf = [];
  const flushBody = () => {
    if (bodyBuf.length) {
      const joined = bodyBuf.join(" ").replace(/\s+/g, " ").trim();
      if (joined) blocks.push({ type: TYPE_BODY, text: joined });
      bodyBuf = [];
    }
  };

  for (const c of classified) {
    if (c.type === TYPE_BLANK) {
      flushBody();
      continue;
    }
    if (c.type === TYPE_HEADING) {
      flushBody();
      blocks.push(c);
      continue;
    }
    if (c.type === TYPE_LIST) {
      flushBody();
      blocks.push(c);
      continue;
    }
    bodyBuf.push(c.text);
  }
  flushBody();

  // 6. Emit. Headings get **...** on their own line. Lists kept verbatim.
  //    Body paragraphs separated by blank lines.
  const out = [];
  let prevType = null;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    // Insert blank line between non-list and any new block, AND between two
    // consecutive list items only if there was a blank line in the original.
    // Simplified: always blank-line between dissimilar consecutive blocks,
    // never blank-line between two consecutive list items.
    if (i > 0 && !(prevType === TYPE_LIST && b.type === TYPE_LIST)) {
      out.push("");
    }
    if (b.type === TYPE_HEADING) out.push(`**${b.text}**`);
    else out.push(b.text);
    prevType = b.type;
  }
  return out.join("\n").trim();
}

/**
 * Strip markdown markers and produce a plain-text version of the cleaned
 * output. Suitable for clipboard when the user doesn't want any markers.
 */
function plainFromCleaned(cleaned) {
  return (cleaned || "")
    .replace(/^[ \t]*\*\*(.+?)\*\*[ \t]*$/gm, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1");
}

module.exports = {
  cleanupOcrText,
  plainFromCleaned,
  // Exported for testing only.
  _internals: {
    isMostlyUppercase,
    isTitleCase,
    looksLikeHeading,
    rejoinHyphenated,
  },
};
