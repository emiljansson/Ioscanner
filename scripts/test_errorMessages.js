// Tests for errorMessages.js. Run with: node scripts/test_errorMessages.js

const path = require("path");
const { classifyError } = require(path.join(
  __dirname, "..", "frontend", "src", "lib", "errorMessages.js"
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
    console.log(`  ✗ ${name}\n    ${e.message.split("\n").join("\n    ")}`);
  }
}

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

// ----------------------------------------------------------------
console.log("\nclassifyError() — out of credit / quota");
// ----------------------------------------------------------------

test("OpenAI 429 insufficient_quota → quota error with billing URL", () => {
  const raw = `OpenAI 429: {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","param":null,"code":"insufficient_quota"}}`;
  const c = classifyError(raw);
  assertEq(c.type, "quota", "type");
  assertEq(c.provider, "openai", "provider");
  assertEq(c.billingUrl, "https://platform.openai.com/account/billing", "billing url");
  if (!c.title.includes("OpenAI")) throw new Error("title should mention OpenAI");
  if (!c.detail.toLowerCase().includes("credit") && !c.detail.toLowerCase().includes("budget")) {
    throw new Error("detail should mention credit or budget");
  }
});

test("Anthropic credit balance too low → quota error", () => {
  const raw = `Claude 400: {"error":{"message":"Your credit balance is too low to access the Claude API."}}`;
  const c = classifyError(raw);
  assertEq(c.type, "quota", "type");
  assertEq(c.provider, "anthropic", "provider");
  if (!c.billingUrl.includes("anthropic")) throw new Error("anthropic billing url");
});

test("Gemini RESOURCE_EXHAUSTED → quota error", () => {
  const raw = `Gemini 429: {"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}`;
  const c = classifyError(raw);
  assertEq(c.type, "quota", "type");
  assertEq(c.provider, "gemini", "provider");
});

// ----------------------------------------------------------------
console.log("\nclassifyError() — invalid API key");
// ----------------------------------------------------------------

test("OpenAI 401 invalid_api_key → invalid_key", () => {
  const raw = `OpenAI 401: {"error":{"message":"Incorrect API key provided","type":"invalid_request_error","code":"invalid_api_key"}}`;
  const c = classifyError(raw);
  assertEq(c.type, "invalid_key", "type");
  assertEq(c.provider, "openai", "provider");
  assertEq(c.openSettings, true, "openSettings flag");
});

test("Gemini API_KEY_INVALID → invalid_key", () => {
  const raw = `Gemini 400: {"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"API_KEY_INVALID"}]}}`;
  const c = classifyError(raw);
  assertEq(c.type, "invalid_key", "type");
});

test("Anthropic 401 → invalid_key", () => {
  const raw = `Claude 401: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`;
  const c = classifyError(raw);
  assertEq(c.type, "invalid_key", "type");
  assertEq(c.provider, "anthropic", "provider");
});

// ----------------------------------------------------------------
console.log("\nclassifyError() — rate limit (NOT quota)");
// ----------------------------------------------------------------

test("OpenAI 429 rate_limit_exceeded → rate_limit", () => {
  const raw = `OpenAI 429: {"error":{"message":"Rate limit reached","type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}`;
  const c = classifyError(raw);
  assertEq(c.type, "rate_limit", "type");
});

test("'Too many requests' → rate_limit", () => {
  const c = classifyError("Gemini 429: too many requests");
  assertEq(c.type, "rate_limit", "type");
});

// ----------------------------------------------------------------
console.log("\nclassifyError() — server / network / timeout");
// ----------------------------------------------------------------

test("OpenAI 500 → server", () => {
  const c = classifyError("OpenAI 500: Internal server error");
  assertEq(c.type, "server", "type");
});

test("Anthropic overloaded → server", () => {
  const c = classifyError(`Claude 529: {"error":{"type":"overloaded_error","message":"Overloaded"}}`);
  assertEq(c.type, "server", "type");
});

test("network failure → network", () => {
  const c = classifyError("Network error: Network request failed");
  assertEq(c.type, "network", "type");
});

test("AbortError-style timeout → timeout", () => {
  const c = classifyError("Request timed out after 120s.");
  assertEq(c.type, "timeout", "type");
});

// ----------------------------------------------------------------
console.log("\nclassifyError() — local guards");
// ----------------------------------------------------------------

test("'No API key set' → no_key with openSettings", () => {
  const c = classifyError("No API key set for OpenAI. Open Settings and paste your key.");
  assertEq(c.type, "no_key", "type");
  assertEq(c.openSettings, true, "openSettings");
});

test("image required → image", () => {
  const c = classifyError("image required");
  assertEq(c.type, "image", "type");
});

// ----------------------------------------------------------------
console.log("\nclassifyError() — fallback");
// ----------------------------------------------------------------

test("unknown message → unknown with shortened detail", () => {
  const long = "x".repeat(500);
  const c = classifyError(long);
  assertEq(c.type, "unknown", "type");
  if (c.detail.length > 250) throw new Error(`detail too long: ${c.detail.length}`);
});

test("fallback extracts 'message' from JSON-like raw", () => {
  const c = classifyError(`Some weird wrapper {"message":"This specific text matters"} blah`);
  assertEq(c.type, "unknown", "type");
  if (!c.detail.includes("This specific text matters")) {
    throw new Error(`expected friendly detail, got: ${c.detail}`);
  }
});

test("null / empty input → unknown", () => {
  const c1 = classifyError(null);
  const c2 = classifyError("");
  assertEq(c1.type, "unknown", "null");
  assertEq(c2.type, "unknown", "empty");
});

// ----------------------------------------------------------------
console.log("\nbefore / after for the user's screenshot");
// ----------------------------------------------------------------

const userExactError = `OpenAI 429: {
  "error": {
    "message": "You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.",
    "type": "insufficient_quota",
    "param": null,
    "code": "insuffici`;

const c = classifyError(userExactError);
console.log("\n  --- BEFORE (current UI) ---");
console.log("  " + userExactError.split("\n").join("\n  "));
console.log("\n  --- AFTER (new UI) ---");
console.log(`  Title : ${c.title}`);
console.log(`  Detail: ${c.detail}`);
console.log(`  Action: Open billing → ${c.billingUrl}`);
console.log("");

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
