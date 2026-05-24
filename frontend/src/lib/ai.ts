// On-device AI client. Routes to whichever provider the user picked in Settings.
// Optionally fans out to "verifier" providers in parallel for consensus scoring.

import {
  getActiveProvider,
  getActiveVerifiers,
  getApiKey,
  providerById,
  ProviderId,
} from "./aiSettings";
import { recordDuration } from "./scanStats";
// Pure-JS module — see confidence.js for the formula + tests.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { scoreConfidence, consensusCurve } = require("./confidence");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { cleanupOcrText, plainFromCleaned } = require("./textCleanup");

// ---------- Progress events ----------
export type ScanStage =
  | "primary_request" // primary HTTPS request started
  | "primary_done" // primary response received
  | "finalize"; // building the result object

export type ScanProgressEvent =
  | {
      kind: "stage";
      stage: ScanStage;
      label: string;
    }
  | {
      kind: "verifier";
      providerId: ProviderId;
      label: string;
      status: "pending" | "ok" | "fail";
    };

export type ScanProgressFn = (e: ScanProgressEvent) => void;

const noop: ScanProgressFn = () => {};

// ---------- Prompts ----------
const OCR_PROMPT = `You are a high-quality OCR engine for English/Swedish documents.
Read the image and return STRICT JSON matching this schema:
{
  "is_document_likelihood": <0-100 how likely the image actually contains readable text from a document/paper/sign/screen. 0 = blank wall/ceiling/sky/random object with no text at all. 30 = mostly empty with a tiny incidental word. 70 = clear document but blurry/cropped. 95-100 = obvious document or sign with readable text. BE STRICT – if you cannot find real readable characters, this MUST be below 20.>,
  "structured_text": "<markdown. Headings as **bold** on their own line, lists as -, keep line breaks. EMPTY STRING if is_document_likelihood < 20.>",
  "plain_text": "<extracted text only, no markdown. EMPTY STRING if is_document_likelihood < 20.>",
  "self_confidence": <0-100 how confident you are in the visual reading. If is_document_likelihood < 20, this MUST also be below 20.>,
  "coherence_score": <0-100 how SEMANTICALLY PLAUSIBLE the text is as a real document. NOT just word spelling. If is_document_likelihood < 20, this MUST also be below 20.>,
  "coherence_note": "<short ENGLISH note (max 120 chars) about any coherence/quality issues, or empty>",
  "page_number": <integer if a page number IS VISIBLE (e.g. "Page 3", "3 (4)", "-3-", footer), otherwise null>,
  "page_note": "<short ENGLISH note about how the page number was found, or empty>"
}
NEVER invent text that isn't visible. If you see no readable text, set is_document_likelihood low and return empty strings.
Find headings (short lines, titles, section labels) and mark them with **double asterisks**.
Preserve the document's original language verbatim. Write nothing outside the JSON object. No code fences.`;

const rescanPrompt = (prev: string) => `You are a high-quality OCR engine. A previous reading produced the following text which may contain errors:
---PREVIOUS---
${prev.slice(0, 6000)}
---END---

Read the new image and CORRECT the previous text. Keep correct parts, fix misspellings, add missing words/lines if visible.
Return STRICT JSON:
{
  "is_document_likelihood": <0-100 — same rules as above, low if the new image isn't a document>,
  "structured_text": "<markdown, headings as **bold**>",
  "plain_text": "<plain text only>",
  "self_confidence": <0-100>,
  "coherence_score": <0-100>,
  "coherence_note": "<English, max 120 chars or empty>",
  "page_number": <integer if page number visible, else null>,
  "page_note": "<short English note or empty>"
}
NEVER invent text that isn't visible. No code fences, no text outside the JSON.`;

const VERIFY_PROMPT =
  "Read the image and return ONLY the verbatim text content as plain text. No commentary, no markdown, no JSON. Preserve line breaks.";

const ORGANIZE_PROMPT = `You receive a list of scanned pages in the order they were photographed. Some already have a detected page_number, others don't. Your task:
1. Use page_number if present and plausible given the content.
2. For pages without a detected number: guess the most likely number based on the neighbours' numbers + the text's content/context.
3. If the most plausible integer fits in the sequence between the neighbours, use it. Otherwise pick the next free integer in the sequence.
4. Two pages must NEVER share the same final number – pick the next free instead.
5. source must be "found" if we kept the already-detected number, otherwise "inferred".
6. note: one short ENGLISH sentence justifying the choice if source=inferred, empty otherwise.

Return STRICT JSON without code fences:
{ "pages": [ { "id": "<same id>", "page_number": <integer>, "source": "found|inferred", "note": "<en>" } ] }`;

// ---------- Helpers ----------
function stripJson(raw: string): string {
  let s = (raw || "").trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "").trim();
  }
  return s;
}

function uuid(): string {
  return (
    Math.random().toString(36).slice(2) +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8)
  );
}

function tokenize(s: string): Set<string> {
  return new Set(
    (s || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1)
  );
}

/** Token-level Jaccard similarity (0-1). Robust to OCR formatting drift. */
function similarity(a: string, b: string): number {
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const uni = A.size + B.size - inter;
  return uni ? inter / uni : 0;
}

function clampConfidence(
  selfConf: number,
  coherence: number,
  isDocLikelihood: number,
  textLen: number,
  consensus: number | null,
  attempts: number
): number {
  // DEPRECATED — kept only so existing imports don't break. The actual math
  // now lives in confidence.js (see scoreConfidence). Will be removed in a
  // follow-up cleanup.
  return scoreConfidence({
    selfConf,
    coherence,
    docLikelihood: isDocLikelihood,
    textLen,
    consensus,
    attempts,
  });
}
// Suppress unused-variable warning while we keep the shim around.
void clampConfidence;

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 120000
): Promise<Response> {
  const attempt = async (): Promise<Response> => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(t);
    }
  };
  try {
    return await attempt();
  } catch (e: any) {
    // Retry once on transient network failures (typical after iPhone unlocks
    // from sleep — radio hasn't fully reconnected yet).
    const msg = String(e?.message ?? "");
    const transient =
      e?.name !== "AbortError" &&
      (msg.includes("Network request failed") ||
        msg.includes("Failed to fetch") ||
        msg.includes("network") ||
        msg.includes("ECONNRESET") ||
        msg.includes("timeout"));
    if (transient) {
      await new Promise((r) => setTimeout(r, 1200));
      try {
        return await attempt();
      } catch (e2: any) {
        if (e2?.name === "AbortError") {
          throw new Error(
            `Request timed out after ${Math.round(timeoutMs / 1000)}s. The model may be slow or unavailable.`
          );
        }
        throw new Error(
          `Network error: ${e2?.message ?? "request failed"}. Check your connection and try again.`
        );
      }
    }
    if (e?.name === "AbortError") {
      throw new Error(
        `Request timed out after ${Math.round(timeoutMs / 1000)}s. The model may be slow or unavailable.`
      );
    }
    throw e;
  }
}

// ---------- Provider routers (JSON output for primary) ----------
async function callOpenAIJson(apiKey: string, prompt: string, imageBase64: string | null): Promise<any> {
  // GPT-5.5 uses the new Responses API (/v1/responses) with input_text / input_image
  const userContent: any[] = [{ type: "input_text", text: prompt }];
  if (imageBase64) {
    userContent.push({
      type: "input_image",
      image_url: `data:image/jpeg;base64,${imageBase64}`,
    });
  }
  const res = await fetchWithTimeout("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-5.5",
      input: [{ role: "user", content: userContent }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const raw: string =
    data?.output_text ??
    (Array.isArray(data?.output)
      ? data.output
          .flatMap((o: any) => o?.content || [])
          .map((c: any) => c?.text || "")
          .join("")
      : "") ??
    "{}";
  return JSON.parse(stripJson(raw));
}

async function callGeminiJson(apiKey: string, prompt: string, imageBase64: string | null): Promise<any> {
  const parts: any[] = [{ text: prompt }];
  if (imageBase64) parts.push({ inline_data: { mime_type: "image/jpeg", data: imageBase64 } });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${encodeURIComponent(
    apiKey
  )}`;
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const raw: string = data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text || "").join("") ?? "{}";
  return JSON.parse(stripJson(raw));
}

async function callAnthropicJson(apiKey: string, prompt: string, imageBase64: string | null): Promise<any> {
  const content: any[] = [];
  if (imageBase64)
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: imageBase64 },
    });
  content.push({ type: "text", text: prompt });
  const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 4000,
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const raw: string = data?.content?.map((c: any) => c?.text || "").join("") ?? "{}";
  return JSON.parse(stripJson(raw));
}

async function callProviderJson(id: ProviderId, apiKey: string, prompt: string, imageBase64: string | null) {
  if (id === "openai") return callOpenAIJson(apiKey, prompt, imageBase64);
  if (id === "gemini") return callGeminiJson(apiKey, prompt, imageBase64);
  return callAnthropicJson(apiKey, prompt, imageBase64);
}

// ---------- Verifier: returns raw plain text ----------
async function verifyText(id: ProviderId, apiKey: string, imageBase64: string): Promise<string> {
  if (id === "openai") {
    const res = await fetchWithTimeout("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: VERIFY_PROMPT },
              {
                type: "input_image",
                image_url: `data:image/jpeg;base64,${imageBase64}`,
              },
            ],
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`verify openai ${res.status}`);
    const data = await res.json();
    const text =
      data?.output_text ??
      (Array.isArray(data?.output)
        ? data.output
            .flatMap((o: any) => o?.content || [])
            .map((c: any) => c?.text || "")
            .join("")
        : "");
    return String(text ?? "").trim();
  }
  if (id === "gemini") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${encodeURIComponent(
      apiKey
    )}`;
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: VERIFY_PROMPT },
              { inline_data: { mime_type: "image/jpeg", data: imageBase64 } },
            ],
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`verify gemini ${res.status}`);
    const data = await res.json();
    return String(data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text || "").join("") ?? "").trim();
  }
  // anthropic
  const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } },
            { type: "text", text: VERIFY_PROMPT },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`verify claude ${res.status}`);
  const data = await res.json();
  return String(data?.content?.map((c: any) => c?.text || "").join("") ?? "").trim();
}

// ---------- Public types ----------
export type ScanResult = {
  id: string;
  structured_text: string;
  plain_text: string;
  confidence_percent: number;
  error_estimate_percent: number;
  coherence_score: number;
  coherence_note: string;
  page_number: number | null;
  page_source: "found" | "inferred" | "missing";
  page_note: string;
  attempts: number;
  /** Average token-overlap with verifiers (0-100). null if no verifiers ran. */
  consensus_score: number | null;
  /** How many verifiers replied successfully. */
  verifier_count: number;
  /** Comma-separated provider ids that were used as verifiers. */
  verifier_labels: string;
};

export type OrganizeInput = {
  id: string;
  plain_text: string;
  detected_page_number: number | null;
  capture_order: number;
};

export type OrganizedPage = {
  id: string;
  page_number: number;
  source: "found" | "inferred";
  note: string;
};

function buildResult(
  r: any,
  attempts: number,
  prevConf: number,
  consensusRaw: number | null, // raw 0-100 Jaccard*100 from runWithConsensus
  verifierCount: number,
  verifierLabels: string
): ScanResult {
  const rawStructured = String(r?.structured_text ?? "");
  const rawPlain =
    String(r?.plain_text ?? "") || rawStructured.replace(/\*\*/g, "");

  // Post-OCR cleanup: rejoin hyphenated word-breaks, detect headings,
  // reflow paragraphs so the text fills an A4 page naturally when pasted
  // into Word. The cleanup is purely structural — it never invents text.
  const structured = cleanupOcrText(rawStructured || rawPlain);
  const plain = plainFromCleaned(structured) || rawPlain;

  const selfConf = Number(r?.self_confidence ?? 60) || 0;
  const coh = Number(r?.coherence_score ?? 60) || 0;
  const docLik = Number(r?.is_document_likelihood ?? 80) || 0;
  let cohNote = String(r?.coherence_note ?? "");
  // Inject a friendly note when the image clearly isn't a document so the
  // user sees WHY confidence is rock-bottom.
  if (docLik < 20 && !cohNote) {
    cohNote = "No readable text detected – is this actually a document?";
  }
  const pageRaw = r?.page_number;
  const pageNum =
    pageRaw != null && Number.isFinite(Number(pageRaw)) ? Math.trunc(Number(pageRaw)) : null;
  const pageNote = String(r?.page_note ?? "");
  const textLen = plain.replace(/\s/g, "").length;

  // Run raw Jaccard*100 through the consensus curve so 0.85 → ~90 instead
  // of literally 85. This matches what we DISPLAY too (see below).
  const consensusCurved =
    consensusRaw == null ? null : consensusCurve(consensusRaw / 100);

  const conf = scoreConfidence({
    selfConf,
    coherence: coh,
    docLikelihood: docLik,
    textLen,
    consensus: consensusCurved,
    attempts,
    prevConfidence: prevConf,
  });
  const err = Math.max(0, Math.round((100 - conf) * 10) / 10);
  return {
    id: uuid(),
    structured_text: structured,
    plain_text: plain,
    confidence_percent: conf,
    error_estimate_percent: err,
    coherence_score: Math.round(coh * 10) / 10,
    coherence_note: cohNote,
    page_number: pageNum,
    page_source: pageNum != null ? "found" : "missing",
    page_note: pageNote,
    attempts,
    // Display the CURVED consensus (90, not 85) so what the user reads
    // matches what fed into the final score.
    consensus_score:
      consensusCurved != null ? Math.round(consensusCurved * 10) / 10 : null,
    verifier_count: verifierCount,
    verifier_labels: verifierLabels,
  };
}

// ---------- Primary + verifier orchestration ----------
async function runWithConsensus(
  prompt: string,
  imageBase64: string,
  onProgress: ScanProgressFn = noop
) {
  const primary = await getActiveProvider();
  const primaryKey = await getApiKey(primary);
  if (!primaryKey) {
    throw new Error(
      `No API key set for ${providerById(primary).label}. Open Settings and paste your key.`
    );
  }

  const primaryLabel = providerById(primary).label;
  const verifiers = await getActiveVerifiers();
  const verifierKeys = await Promise.all(verifiers.map((v) => getApiKey(v)));

  // Emit "pending" status for every verifier up-front so the UI can render
  // grey chips before any network activity happens.
  for (const v of verifiers) {
    onProgress({
      kind: "verifier",
      providerId: v,
      label: providerById(v).label,
      status: "pending",
    });
  }

  onProgress({
    kind: "stage",
    stage: "primary_request",
    label: verifiers.length
      ? `${primaryLabel} is reading the document…`
      : `${primaryLabel} is reading the document…`,
  });

  // Primary call (JSON) + verifier calls (plain text) in parallel
  const primaryTask = callProviderJson(primary, primaryKey, prompt, imageBase64)
    .then((res) => {
      onProgress({
        kind: "stage",
        stage: "primary_done",
        label: verifiers.length
          ? `${primaryLabel} done · waiting for verifiers…`
          : `${primaryLabel} done · finalizing…`,
      });
      return res;
    });

  const verifierTasks = verifiers.map((v, i) =>
    verifyText(v, verifierKeys[i], imageBase64).then(
      (text) => {
        onProgress({
          kind: "verifier",
          providerId: v,
          label: providerById(v).label,
          status: "ok",
        });
        return text;
      },
      (e) => {
        console.warn(`verifier ${v} failed:`, e?.message ?? e);
        onProgress({
          kind: "verifier",
          providerId: v,
          label: providerById(v).label,
          status: "fail",
        });
        return null;
      }
    )
  );

  const [primaryRes, ...verifierResults] = await Promise.all([
    primaryTask,
    ...verifierTasks,
  ]);
  const primaryPlain = String(primaryRes?.plain_text ?? "");
  const goodTexts: string[] = [];
  const goodLabels: string[] = [];
  verifierResults.forEach((t, i) => {
    if (typeof t === "string" && t.length > 0) {
      goodTexts.push(t);
      goodLabels.push(providerById(verifiers[i]).label);
    }
  });

  let consensus: number | null = null;
  if (goodTexts.length > 0 && primaryPlain) {
    const sims = goodTexts.map((t) => similarity(primaryPlain, t));
    const avg = sims.reduce((a, b) => a + b, 0) / sims.length;
    consensus = avg * 100;
  }

  onProgress({
    kind: "stage",
    stage: "finalize",
    label: "Finalizing result…",
  });

  return {
    primaryRes,
    consensus,
    verifierCount: goodTexts.length,
    verifierLabels: goodLabels.join(", "),
  };
}

// ---------- Public API ----------
export async function runOcrScan(
  imageBase64: string,
  onProgress: ScanProgressFn = noop
): Promise<ScanResult> {
  if (!imageBase64) throw new Error("image required");
  const t0 = Date.now();
  const { primaryRes, consensus, verifierCount, verifierLabels } =
    await runWithConsensus(OCR_PROMPT, imageBase64, onProgress);
  const result = buildResult(primaryRes, 1, 0, consensus, verifierCount, verifierLabels);
  // Fire-and-forget: don't await – we don't want to slow the UI down.
  recordDuration((Date.now() - t0) / 1000).catch(() => {});
  return result;
}

export async function runOcrRescan(
  imageBase64: string,
  previousText: string,
  previousConfidence: number,
  attempts: number,
  onProgress: ScanProgressFn = noop
): Promise<ScanResult> {
  if (!imageBase64) throw new Error("image required");
  const t0 = Date.now();
  const { primaryRes, consensus, verifierCount, verifierLabels } =
    await runWithConsensus(rescanPrompt(previousText), imageBase64, onProgress);
  const result = buildResult(
    primaryRes,
    Math.max(2, attempts + 1),
    previousConfidence || 0,
    consensus,
    verifierCount,
    verifierLabels
  );
  recordDuration((Date.now() - t0) / 1000).catch(() => {});
  return result;
}

export async function runOrganize(pages: OrganizeInput[]): Promise<OrganizedPage[]> {
  if (!pages.length) return [];
  if (pages.length === 1 && pages[0].detected_page_number == null) {
    return [
      {
        id: pages[0].id,
        page_number: 1,
        source: "inferred",
        note: "Only one page – numbered as 1.",
      },
    ];
  }
  const items = pages.map((p) => ({
    id: p.id,
    capture_order: p.capture_order,
    detected_page_number: p.detected_page_number,
    text_excerpt: (p.plain_text || "").slice(0, 600),
  }));
  try {
    const primary = await getActiveProvider();
    const primaryKey = await getApiKey(primary);
    if (!primaryKey) throw new Error("no key");
    const r = await callProviderJson(
      primary,
      primaryKey,
      ORGANIZE_PROMPT + "\n\nPages:\n" + JSON.stringify(items),
      null
    );
    const arr: any[] = Array.isArray(r?.pages) ? r.pages : [];
    const used = new Set<number>();
    return arr.map((p) => {
      let n = Number(p?.page_number);
      if (!Number.isFinite(n) || used.has(n)) {
        let next = used.size ? Math.max(...used) + 1 : 1;
        while (used.has(next)) next++;
        n = next;
      }
      used.add(n);
      return {
        id: String(p?.id ?? ""),
        page_number: n,
        source: p?.source === "found" ? "found" : "inferred",
        note: String(p?.note ?? ""),
      };
    });
  } catch {
    const used = new Set<number>(
      pages.map((p) => p.detected_page_number).filter((n): n is number => n != null)
    );
    const out: OrganizedPage[] = [];
    let next = 1;
    for (const p of [...pages].sort((a, b) => a.capture_order - b.capture_order)) {
      if (p.detected_page_number != null) {
        out.push({ id: p.id, page_number: p.detected_page_number, source: "found", note: "" });
      } else {
        while (used.has(next)) next++;
        used.add(next);
        out.push({
          id: p.id,
          page_number: next,
          source: "inferred",
          note: "No page number found – auto-assigned.",
        });
        next++;
      }
    }
    return out;
  }
}

// ---------- Test connection (used by Settings) ----------
export async function testConnection(id: ProviderId, apiKey: string): Promise<string> {
  const ping = 'Reply with the exact JSON: {"ok": true}';
  const r = await callProviderJson(id, apiKey, ping, null);
  return r?.ok ? `${providerById(id).label} ✓` : `${providerById(id).label} responded`;
}
