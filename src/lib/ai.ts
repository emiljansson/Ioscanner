// On-device OpenAI client. Replaces the previous backend (/api/ocr/*).
// Reads the API key from EXPO_PUBLIC_OPENAI_API_KEY (set in .env or
// Expo Launch project env vars).

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-5.2";

function getKey(): string {
  return process.env.EXPO_PUBLIC_OPENAI_API_KEY || "";
}

// ---------- Prompts ----------
const OCR_PROMPT = `You are a high-quality OCR engine for English/Swedish documents.
Read the image and return STRICT JSON matching this schema:
{
  "structured_text": "<markdown. Headings as **bold** on their own line, lists as -, keep line breaks>",
  "plain_text": "<extracted text only, no markdown>",
  "self_confidence": <0-100 how confident you are in the visual reading>,
  "coherence_score": <0-100 how SEMANTICALLY PLAUSIBLE the text is as a real document (linguistic coherence, sentence flow, plausible values) – NOT just whether individual words are spelled correctly>,
  "coherence_note": "<short ENGLISH note (max 120 chars) about any coherence issues, or empty>",
  "page_number": <integer if a page number IS VISIBLE on the page (e.g. "Page 3", "3 (4)", "-3-", footer), otherwise null>,
  "page_note": "<short ENGLISH note about how the page number was found, or empty>"
}
Find headings (short lines, titles, section labels) and mark them with **double asterisks**.
Preserve the document's original language verbatim. Write nothing outside the JSON object. No code fences.`;

const rescanPrompt = (prev: string) => `You are a high-quality OCR engine. A previous reading produced the following text which may contain errors:
---PREVIOUS---
${prev.slice(0, 6000)}
---END---

Read the new image and CORRECT the previous text. Keep correct parts, fix misspellings, add missing words/lines if visible in the image.
Return STRICT JSON:
{
  "structured_text": "<markdown, headings as **bold**>",
  "plain_text": "<plain text only>",
  "self_confidence": <0-100>,
  "coherence_score": <0-100>,
  "coherence_note": "<English, max 120 chars or empty>",
  "page_number": <integer if page number visible, else null>,
  "page_note": "<short English note or empty>"
}
No code fences, no text outside the JSON.`;

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

function clampConfidence(
  selfConf: number,
  coherence: number,
  attempts: number
): number {
  // Single-model variant: blend self_confidence and coherence + per-attempt bonus
  const base = 0.55 * (selfConf || 0) + 0.45 * (coherence || 0);
  const bonus = Math.min(12, Math.max(0, attempts - 1) * 4);
  return Math.round(Math.min(99, base + bonus) * 10) / 10;
}

async function callOpenAI(content: any[], maxTokens = 4000): Promise<any> {
  const key = getKey();
  if (!key) {
    throw new Error(
      "OpenAI API key missing. Set EXPO_PUBLIC_OPENAI_API_KEY in your .env (local) or Expo Launch project environment variables."
    );
  }
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content }],
      max_completion_tokens: maxTokens,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const raw: string = data?.choices?.[0]?.message?.content ?? "{}";
  try {
    return JSON.parse(stripJson(raw));
  } catch {
    throw new Error(
      `Could not parse OpenAI response as JSON: ${String(raw).slice(0, 200)}`
    );
  }
}

// ---------- Types ----------
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
  prevConf: number
): ScanResult {
  const structured = String(r?.structured_text ?? "");
  const plain = String(r?.plain_text ?? "") || structured.replace(/\*\*/g, "");
  const selfConf = Number(r?.self_confidence ?? 60) || 0;
  const coh = Number(r?.coherence_score ?? 60) || 0;
  const cohNote = String(r?.coherence_note ?? "");
  const pageRaw = r?.page_number;
  const pageNum =
    pageRaw != null && Number.isFinite(Number(pageRaw))
      ? Math.trunc(Number(pageRaw))
      : null;
  const pageNote = String(r?.page_note ?? "");
  let conf = clampConfidence(selfConf, coh, attempts);
  if (conf < prevConf) {
    conf = Math.min(99, Math.round((prevConf + 2) * 10) / 10);
  }
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
  };
}

// ---------- Public API ----------
export async function runOcrScan(imageBase64: string): Promise<ScanResult> {
  if (!imageBase64) throw new Error("image required");
  const r = await callOpenAI([
    { type: "text", text: OCR_PROMPT },
    {
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
    },
  ]);
  return buildResult(r, 1, 0);
}

export async function runOcrRescan(
  imageBase64: string,
  previousText: string,
  previousConfidence: number,
  attempts: number
): Promise<ScanResult> {
  if (!imageBase64) throw new Error("image required");
  const r = await callOpenAI([
    { type: "text", text: rescanPrompt(previousText) },
    {
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
    },
  ]);
  return buildResult(r, Math.max(2, attempts + 1), previousConfidence || 0);
}

export async function runOrganize(
  pages: OrganizeInput[]
): Promise<OrganizedPage[]> {
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
    const r = await callOpenAI([
      {
        type: "text",
        text: ORGANIZE_PROMPT + "\n\nPages:\n" + JSON.stringify(items),
      },
    ]);
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
    // Deterministic fallback if AI fails
    const used = new Set<number>(
      pages
        .map((p) => p.detected_page_number)
        .filter((n): n is number => n != null)
    );
    const out: OrganizedPage[] = [];
    let next = 1;
    for (const p of [...pages].sort((a, b) => a.capture_order - b.capture_order)) {
      if (p.detected_page_number != null) {
        out.push({
          id: p.id,
          page_number: p.detected_page_number,
          source: "found",
          note: "",
        });
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
