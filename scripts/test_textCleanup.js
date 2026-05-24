// Unit tests for textCleanup.js. Run with: node scripts/test_textCleanup.js

const path = require("path");
const {
  cleanupOcrText,
  plainFromCleaned,
  _internals,
} = require(path.join(__dirname, "..", "frontend", "src", "lib", "textCleanup.js"));

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
    console.log(`    ${e.message.split("\n").join("\n    ")}`);
  }
}

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label}\n      expected:\n${expected.split("\n").map((l) => "        " + JSON.stringify(l)).join("\n")}\n      actual:\n${actual.split("\n").map((l) => "        " + JSON.stringify(l)).join("\n")}`
    );
  }
}

function assertIncludes(actual, needle, label) {
  if (!actual.includes(needle)) {
    throw new Error(`${label}\n      expected to find: ${JSON.stringify(needle)}\n      in:\n${actual}`);
  }
}

function assertNotIncludes(actual, needle, label) {
  if (actual.includes(needle)) {
    throw new Error(`${label}\n      did NOT expect to find: ${JSON.stringify(needle)}\n      in:\n${actual}`);
  }
}

// ----------------------------------------------------------------
console.log("\nrejoinHyphenated()");
// ----------------------------------------------------------------

test("rejoins simple hyphenated word", () => {
  const out = _internals.rejoinHyphenated("admin-\nistrator");
  assertEq(out, "administrator", "simple hyphen");
});

test("rejoins Swedish hyphenated word", () => {
  const out = _internals.rejoinHyphenated("verksam-\nheten");
  assertEq(out, "verksamheten", "Swedish hyphen");
});

test("does NOT rejoin if next line starts uppercase (proper noun)", () => {
  const out = _internals.rejoinHyphenated("foo-\nBar");
  assertEq(out, "foo-\nBar", "uppercase guard");
});

test("does NOT rejoin standalone hyphen (e.g. dashes)", () => {
  const out = _internals.rejoinHyphenated("a — b");
  assertEq(out, "a — b", "em dash");
});

// ----------------------------------------------------------------
console.log("\nheading detectors");
// ----------------------------------------------------------------

test("ALL CAPS short line is heading", () => {
  if (!_internals.isMostlyUppercase("INTRODUCTION")) throw new Error("INTRODUCTION not detected");
});

test("normal sentence is NOT heading", () => {
  if (_internals.isMostlyUppercase("This is a normal sentence.")) {
    throw new Error("'This is...' falsely flagged");
  }
});

test("title case detected", () => {
  if (!_internals.isTitleCase("Introduction to OCR")) {
    throw new Error("'Introduction to OCR' not detected");
  }
});

test("title case allows lowercase joiners", () => {
  if (!_internals.isTitleCase("The History of Sweden")) {
    throw new Error("'The History of Sweden' not detected");
  }
});

test("looksLikeHeading rejects sentences", () => {
  if (_internals.looksLikeHeading("This is a complete sentence.", true, true)) {
    throw new Error("trailing period should disqualify");
  }
});

test("looksLikeHeading accepts section keyword", () => {
  if (!_internals.looksLikeHeading("Chapter 3 Introduction", false, false)) {
    throw new Error("Chapter keyword not detected");
  }
});

test("looksLikeHeading needs blank context for plain title case", () => {
  // Without blank context, title-case is NOT enough
  if (_internals.looksLikeHeading("This Is Title Case", false, false)) {
    throw new Error("title case without context should NOT be heading");
  }
  // With blank context, it IS enough
  if (!_internals.looksLikeHeading("This Is Title Case", true, true)) {
    throw new Error("title case WITH context should be heading");
  }
});

// ----------------------------------------------------------------
console.log("\ncleanupOcrText — real-world scenarios");
// ----------------------------------------------------------------

test("two-column doc: lines glued into paragraph (A4-friendly)", () => {
  // Typical: OCR'd a one-column section but lines wrap at narrow width.
  const input = [
    "INTRODUCTION",
    "",
    "This document describes the OCR",
    "pipeline used by CopyThat. It",
    "explains the data flow from camera",
    "capture all the way to clipboard.",
    "",
    "We use multiple AI models in parallel.",
  ].join("\n");
  const out = cleanupOcrText(input);
  assertIncludes(out, "**INTRODUCTION**", "heading kept");
  assertIncludes(
    out,
    "This document describes the OCR pipeline used by CopyThat. It explains the data flow from camera capture all the way to clipboard.",
    "first paragraph joined into one line"
  );
  assertIncludes(out, "We use multiple AI models in parallel.", "second paragraph kept");
});

test("hyphenated word breaks rejoined", () => {
  const input = "The admin-\nistrator approved the request.";
  const out = cleanupOcrText(input);
  assertIncludes(out, "The administrator approved the request.", "hyphenated word fixed");
  assertNotIncludes(out, "admin-", "no broken hyphen left");
});

test("list items preserved, each on own line", () => {
  const input = [
    "Shopping list",
    "",
    "- Milk",
    "- Bread",
    "- Eggs",
  ].join("\n");
  const out = cleanupOcrText(input);
  const lines = out.split("\n");
  // Each dash item should be on its own line
  const dashLines = lines.filter((l) => /^- /.test(l));
  if (dashLines.length !== 3) {
    throw new Error(`expected 3 list lines, got ${dashLines.length}:\n${out}`);
  }
});

test("numbered list preserved", () => {
  const input = [
    "STEPS",
    "",
    "1. Open the app",
    "2. Point camera",
    "3. Tap shutter",
  ].join("\n");
  const out = cleanupOcrText(input);
  if (!/^1\. Open the app/m.test(out)) throw new Error("step 1 missing");
  if (!/^2\. Point camera/m.test(out)) throw new Error("step 2 missing");
  if (!/^3\. Tap shutter/m.test(out)) throw new Error("step 3 missing");
});

test("existing **markdown headings** preserved", () => {
  const input = [
    "**Already a heading**",
    "",
    "Some body text here.",
  ].join("\n");
  const out = cleanupOcrText(input);
  assertIncludes(out, "**Already a heading**", "md heading kept");
});

test("ALL CAPS line detected as heading WITHOUT blank context", () => {
  const input = [
    "NEW SECTION",
    "Body text follows immediately without blank line.",
  ].join("\n");
  const out = cleanupOcrText(input);
  assertIncludes(out, "**NEW SECTION**", "ALL CAPS still detected");
});

test("title case mid-paragraph is NOT promoted to heading", () => {
  // 'The Best Way' inside a sentence shouldn't be marked as heading
  const input =
    "Programming requires The Best Way to think about problems and design solutions.";
  const out = cleanupOcrText(input);
  assertNotIncludes(out, "**The Best Way**", "false-positive heading guarded");
});

test("paragraph boundaries preserved (blank lines stay)", () => {
  const input = [
    "First paragraph.",
    "Continues here.",
    "",
    "Second paragraph.",
    "Continues here.",
  ].join("\n");
  const out = cleanupOcrText(input);
  const blocks = out.split("\n\n");
  if (blocks.length !== 2) {
    throw new Error(`expected 2 paragraphs, got ${blocks.length}:\n${out}`);
  }
  if (!blocks[0].includes("First paragraph. Continues here.")) {
    throw new Error("first paragraph not joined");
  }
  if (!blocks[1].includes("Second paragraph. Continues here.")) {
    throw new Error("second paragraph not joined");
  }
});

test("empty input returns empty string", () => {
  assertEq(cleanupOcrText(""), "", "empty");
  assertEq(cleanupOcrText("   \n\n   "), "", "whitespace only");
  assertEq(cleanupOcrText(null), "", "null");
});

test("trailing whitespace stripped", () => {
  const input = "Hello world.   \n   ";
  const out = cleanupOcrText(input);
  assertEq(out, "Hello world.", "trailing");
});

test("Swedish heading detection", () => {
  const input = [
    "AVDELNING 3 - Säkerhet",
    "",
    "Användaren ansvarar för att hålla sin enhet säker.",
  ].join("\n");
  const out = cleanupOcrText(input);
  assertIncludes(out, "**AVDELNING 3 - Säkerhet**", "swedish heading");
});

test("Section keyword (Swedish) detected as heading", () => {
  const input = [
    "Some context.",
    "",
    "Kapitel 5",
    "",
    "More text.",
  ].join("\n");
  const out = cleanupOcrText(input);
  assertIncludes(out, "**Kapitel 5**", "Kapitel keyword");
});

test("plainFromCleaned strips ** markers", () => {
  const cleaned = "**Heading**\n\nSome text with **bold** in it.";
  const plain = plainFromCleaned(cleaned);
  assertEq(plain, "Heading\n\nSome text with bold in it.", "plain conversion");
});

test("does not promote URL-like lines to headings", () => {
  const input = [
    "Visit our site",
    "",
    "https://example.com",
    "",
    "for more info.",
  ].join("\n");
  const out = cleanupOcrText(input);
  // The URL line shouldn't become a heading
  assertNotIncludes(out, "**https", "url not heading");
});

test("complex real-world Swedish document", () => {
  const input = [
    "AVSNITT 1",
    "",
    "Detta är en text som har",
    "blivit OCR-skannad från ett",
    "papper. Texten är felaktigt",
    "uppdelad på flera rader.",
    "",
    "- Punkt ett",
    "- Punkt två",
    "- Punkt tre",
    "",
    "Avslut",
    "",
    "Sista stycket avslutar doku-",
    "mentet med en mening.",
  ].join("\n");
  const out = cleanupOcrText(input);
  assertIncludes(out, "**AVSNITT 1**", "first heading");
  assertIncludes(
    out,
    "Detta är en text som har blivit OCR-skannad från ett papper. Texten är felaktigt uppdelad på flera rader.",
    "first paragraph reflowed"
  );
  assertIncludes(out, "- Punkt ett", "list 1");
  assertIncludes(out, "- Punkt två", "list 2");
  assertIncludes(out, "- Punkt tre", "list 3");
  assertIncludes(
    out,
    "Sista stycket avslutar dokumentet med en mening.",
    "hyphenated 'doku-mentet' rejoined"
  );
});

// ----------------------------------------------------------------
console.log("\nbefore / after visualisation");
// ----------------------------------------------------------------

const demo = [
  "DOKUMENT",
  "",
  "Detta dokument är en sam-",
  "manställning av regler för",
  "alla anställda. Det ska läsas",
  "noga.",
  "",
  "Regler",
  "",
  "1. Var i tid",
  "2. Var trevlig mot kunder",
  "3. Skriv inte ner lösenord",
  "",
  "Avslutning",
  "",
  "Tack för att du läste detta.",
].join("\n");

console.log("\n  --- BEFORE ---");
console.log(demo.split("\n").map((l) => "  " + l).join("\n"));
console.log("\n  --- AFTER ---");
console.log(cleanupOcrText(demo).split("\n").map((l) => "  " + l).join("\n"));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
