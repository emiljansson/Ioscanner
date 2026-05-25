// Friendly error classification for AI provider failures.
// Pure JS so it can be unit-tested in plain Node.
//
// Each provider returns errors in a different shape, but we forward the
// raw HTTP status + response body as the Error message in ai.ts (e.g.
// "OpenAI 429: {...json...}"). This module pattern-matches on that string
// and returns a UI-friendly summary the camera screen can show in an Alert.

const BILLING_URLS = {
  openai: "https://platform.openai.com/account/billing",
  anthropic: "https://console.anthropic.com/settings/billing",
  gemini: "https://aistudio.google.com/app/apikey",
};

/**
 * Classify a raw error message.
 * @param {string} rawMessage  The error message (typically `err.message`).
 * @returns {{
 *   type: "quota" | "invalid_key" | "rate_limit" | "server" | "network"
 *        | "timeout" | "no_key" | "image" | "unknown",
 *   provider: "openai" | "anthropic" | "gemini" | null,
 *   title: string,
 *   detail: string,
 *   billingUrl: string | null,
 *   openSettings: boolean
 * }}
 */
function classifyError(rawMessage) {
  const raw = String(rawMessage || "");
  const m = raw.toLowerCase();
  const provider = detectProvider(m);

  // ----- 0. Local "no key" guard from ai.ts -----
  if (m.includes("no api key set")) {
    return {
      type: "no_key",
      provider,
      title: "No API key set",
      detail:
        "Open Settings and paste your API key for the provider you want to use.",
      billingUrl: null,
      openSettings: true,
    };
  }

  // ----- 1. Out of credit / quota -----
  // OpenAI: 429 + "insufficient_quota"
  // Anthropic: 400 + "credit balance is too low"
  // Gemini: 429 + "RESOURCE_EXHAUSTED" / "quota"
  const quotaSignals = [
    "insufficient_quota",
    "credit balance is too low",
    "billing_not_active",
    "exceeded your current quota",
    "resource_exhausted",
    "you exceeded your quota",
  ];
  if (quotaSignals.some((s) => m.includes(s))) {
    return {
      type: "quota",
      provider,
      title: `${prettyName(provider)} — out of credit`,
      detail:
        `Your ${prettyName(provider)} account has run out of credit or hit its monthly budget. Top up your balance, then try again.`,
      billingUrl: provider ? BILLING_URLS[provider] : null,
      openSettings: false,
    };
  }

  // ----- 2. Invalid API key -----
  // OpenAI/Anthropic: 401 + "invalid_api_key"
  // Gemini: 400 + "API_KEY_INVALID" / 403
  const keySignals = [
    "invalid_api_key",
    "incorrect api key",
    "api_key_invalid",
    "authentication failed",
    "unauthorized",
    "invalid x-api-key",
    "invalid api key",
  ];
  if (
    keySignals.some((s) => m.includes(s)) ||
    /\b401\b/.test(m) ||
    /\b403\b/.test(m)
  ) {
    return {
      type: "invalid_key",
      provider,
      title: `${prettyName(provider)} — API key rejected`,
      detail:
        `${prettyName(provider)} did not accept your API key. Open Settings, double-check the key (including the prefix), and try Test again.`,
      billingUrl: null,
      openSettings: true,
    };
  }

  // ----- 3. Rate limit (not quota) -----
  // OpenAI: 429 + "rate_limit_exceeded"  (but NOT insufficient_quota — handled above)
  if (
    /\b429\b/.test(m) ||
    m.includes("rate_limit") ||
    m.includes("rate limit") ||
    m.includes("too many requests")
  ) {
    return {
      type: "rate_limit",
      provider,
      title: `${prettyName(provider)} — too many requests`,
      detail:
        `You're hitting ${prettyName(provider)}'s rate limit. Wait a few seconds and try again.`,
      billingUrl: null,
      openSettings: false,
    };
  }

  // ----- 4. Server / overloaded -----
  if (
    /\b5\d\d\b/.test(m) ||
    m.includes("overloaded") ||
    m.includes("service unavailable") ||
    m.includes("internal server error") ||
    m.includes("bad gateway")
  ) {
    return {
      type: "server",
      provider,
      title: `${prettyName(provider)} is having issues`,
      detail:
        `${prettyName(provider)}'s servers are temporarily overloaded or down. Wait a moment and try again, or switch to a different provider in Settings.`,
      billingUrl: null,
      openSettings: false,
    };
  }

  // ----- 5. Timeout -----
  if (m.includes("timed out") || m.includes("aborterror")) {
    return {
      type: "timeout",
      provider,
      title: "Request timed out",
      detail:
        "The AI took too long to respond. Try again — slower networks or large images can hit the timeout.",
      billingUrl: null,
      openSettings: false,
    };
  }

  // ----- 6. Network -----
  if (
    m.includes("network request failed") ||
    m.includes("failed to fetch") ||
    m.includes("network error") ||
    m.includes("econnreset") ||
    m.includes("offline")
  ) {
    return {
      type: "network",
      provider,
      title: "No internet connection",
      detail:
        "We couldn't reach the AI server. Check your Wi-Fi or mobile data and try again.",
      billingUrl: null,
      openSettings: false,
    };
  }

  // ----- 7. Image / format problems from ai.ts itself -----
  if (
    m.includes("image required") ||
    m.includes("could not encode image") ||
    m.includes("no image captured")
  ) {
    return {
      type: "image",
      provider: null,
      title: "Could not capture the image",
      detail:
        "Try again — make sure the camera has time to focus and the document is well lit.",
      billingUrl: null,
      openSettings: false,
    };
  }

  // ----- Fallback -----
  // Trim the raw message so we don't show a 5KB JSON dump.
  return {
    type: "unknown",
    provider,
    title: `${prettyName(provider) || "Scan"} failed`,
    detail: shortenForUser(raw),
    billingUrl: null,
    openSettings: false,
  };
}

function detectProvider(lowercaseMsg) {
  if (lowercaseMsg.startsWith("openai") || lowercaseMsg.includes("openai")) {
    return "openai";
  }
  if (
    lowercaseMsg.startsWith("claude") ||
    lowercaseMsg.includes("anthropic") ||
    lowercaseMsg.includes("claude")
  ) {
    return "anthropic";
  }
  if (lowercaseMsg.startsWith("gemini") || lowercaseMsg.includes("gemini") || lowercaseMsg.includes("googleapis")) {
    return "gemini";
  }
  return null;
}

function prettyName(provider) {
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic") return "Claude";
  if (provider === "gemini") return "Gemini";
  return "AI";
}

function shortenForUser(raw) {
  // Strip JSON-y noise, keep the first meaningful sentence.
  // Find the first "message": "..." pattern (common across providers).
  const msgMatch = raw.match(/"message"\s*:\s*"([^"]+)"/);
  if (msgMatch) return msgMatch[1];
  // Otherwise return the first 200 characters of the raw message.
  const cleaned = raw.replace(/[{}\[\]"\\]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > 200 ? cleaned.slice(0, 200) + "…" : cleaned;
}

module.exports = {
  classifyError,
  // exposed for tests
  _internals: { detectProvider, shortenForUser, prettyName, BILLING_URLS },
};
