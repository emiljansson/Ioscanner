"""AI providers (OpenAI, Gemini, Anthropic), OCR prompts, consensus, free instructions."""
import re
import json
import asyncio
import base64

import httpx

from core import get_ai_keys, log

MODELS = {
    "openai": {"fast": "gpt-5-mini", "balanced": "gpt-5", "best": "gpt-5.5"},
    "gemini": {"fast": "gemini-2.5-flash", "balanced": "gemini-2.5-pro", "best": "gemini-3.1-pro-preview"},
    "anthropic": {"fast": "claude-haiku-4-5", "balanced": "claude-sonnet-4-5", "best": "claude-sonnet-4-5"},
}
LABELS = {"openai": "OpenAI", "gemini": "Gemini", "anthropic": "Claude"}
TIMEOUTS = {"fast": 90, "balanced": 150, "best": 240}

OCR_PROMPT = """You are an expert OCR engine for STUDY MATERIAL (textbooks, compendiums, lecture notes, exercise sheets) in Swedish or English.
Read the page image and return STRICT JSON (no code fences, nothing outside the JSON):
{
  "is_document_likelihood": <0-100, below 20 if there is no readable text>,
  "markdown": "<the page as Markdown, rules below>",
  "self_confidence": <0-100 how sure you are of the reading>,
  "coherence_score": <0-100 how semantically plausible the text is>,
  "coherence_note": "<short Swedish note about quality issues, or empty>",
  "page_number": <integer if a printed page number is visible, else null>,
  "figures": [ { "id": <1,2,...>, "box_2d": [ymin, xmin, ymax, xmax], "caption": "<figure caption text or empty>" } ]
}
MARKDOWN RULES:
- Reading order: in multi-column layouts read each column top to bottom, left column first.
- Headings with #, ##, ### following the visual hierarchy.
- Paragraphs as continuous text: join lines broken only by the layout, rejoin words hyphenated at line ends. Blank line between paragraphs.
- Lists with "-" or "1.". Keep exercise numbering.
- Math: inline LaTeX in $...$, display formulas in $$...$$ on their own lines. Chemical formulas also as LaTeX (e.g. $\\mathrm{H_2O}$).
- Tables: GitHub pipe tables with a header row.
- OMIT running headers, footers and page numbers.
- Photos, diagrams, charts, maps and illustrations: put the placeholder [[FIGURE:id]] on its own line where the figure appears, and add it to "figures" with box_2d normalized 0-1000 as [ymin, xmin, ymax, xmax] tightly covering the whole figure (excluding the caption). Do not transcribe text inside figures. The caption (e.g. "Figur 3.2 ...") goes ONLY in "caption", not in markdown. Do not mark decorative lines, logos-in-header or plain text boxes as figures.
- Handwritten notes in the margin: add as a blockquote "> Anteckning: ...".
- NEVER invent text. Keep the original language verbatim."""

VERIFY_PROMPT = "Read the image and return ONLY the verbatim text content as plain text. No commentary, no markdown, no JSON."

INSTRUCTION_SYSTEM = """You are a helpful study assistant. You receive study material (Markdown, may contain LaTeX math in $...$ and $$...$$, pipe tables and image references like ![caption](fig:ID)) and an instruction from the student.
Follow the instruction and answer in Markdown. Keep math as LaTeX in $...$ / $$...$$, tables as pipe tables. You may reuse relevant image references exactly as given (![caption](fig:ID)); never invent new ones.
Answer in the language of the material unless the instruction says otherwise. Return ONLY the resulting document, no preamble."""


class AIError(Exception):
    pass


def strip_json(raw: str) -> dict:
    s = (raw or "").strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\n?", "", s)
        s = re.sub(r"\n?```$", "", s).strip()
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", s, re.S)
        if m:
            return json.loads(m.group(0))
        raise AIError("AI:n svarade inte med giltig JSON")


async def _post(url: str, headers: dict, body: dict, timeout: int, label: str) -> dict:
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(url, headers=headers, json=body)
    except httpx.TimeoutException:
        raise AIError(f"{label}: tidsgränsen ({timeout} s) passerades")
    except httpx.HTTPError as e:
        raise AIError(f"{label}: nätverksfel ({e.__class__.__name__})")
    if r.status_code >= 400:
        raise AIError(friendly_error(label, r.status_code, r.text))
    return r.json()


def friendly_error(label: str, status: int, text: str) -> str:
    t = text.lower()
    if status in (401, 403) or "api key" in t or "invalid x-api-key" in t:
        return f"{label}: AI-nyckeln är ogiltig eller saknar behörighet"
    if status == 429 or "quota" in t or "credit" in t or "billing" in t:
        return f"{label}: krediten är slut eller för många anrop – fyll på kontot hos {label} eller vänta en stund"
    if status in (500, 502, 503, 529) or "overloaded" in t:
        return f"{label}: tjänsten är överbelastad just nu, försök igen om en stund"
    return f"{label} {status}: {text[:200]}"


async def call_ai(provider: str, model: str, prompt: str, image_jpeg: bytes | None, timeout: int,
                  want_json: bool, system: str | None = None, max_tokens: int = 8000) -> str:
    keys = await get_ai_keys()
    key = keys.get(provider)
    label = LABELS[provider]
    if not key:
        raise AIError(f"{label}: AI-nyckel saknas på servern")
    b64 = base64.b64encode(image_jpeg).decode() if image_jpeg else None
    if provider == "openai":
        content = [{"type": "input_text", "text": prompt}]
        if b64:
            content.append({"type": "input_image", "image_url": f"data:image/jpeg;base64,{b64}"})
        body = {"model": model, "input": [{"role": "user", "content": content}]}
        if system:
            body["instructions"] = system
        data = await _post("https://api.openai.com/v1/responses",
                           {"Authorization": f"Bearer {key}"}, body, timeout, label)
        out = data.get("output_text")
        if not out:
            out = "".join(c.get("text", "") for o in data.get("output", []) for c in (o.get("content") or []))
        return out
    if provider == "gemini":
        parts = [{"text": prompt}]
        if b64:
            parts.append({"inline_data": {"mime_type": "image/jpeg", "data": b64}})
        body = {"contents": [{"role": "user", "parts": parts}]}
        if want_json:
            body["generationConfig"] = {"responseMimeType": "application/json"}
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}
        data = await _post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}",
            {}, body, timeout, label)
        cands = data.get("candidates") or [{}]
        return "".join(p.get("text", "") for p in (cands[0].get("content") or {}).get("parts", []))
    content = []
    if b64:
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64}})
    content.append({"type": "text", "text": prompt})
    body = {"model": model, "max_tokens": max_tokens, "messages": [{"role": "user", "content": content}]}
    if system:
        body["system"] = system
    data = await _post("https://api.anthropic.com/v1/messages",
                       {"x-api-key": key, "anthropic-version": "2023-06-01"}, body, timeout, label)
    return "".join(c.get("text", "") for c in data.get("content", []))


# ---------------- Confidence (port of confidence.js) ----------------
def _tokens(s: str) -> set:
    s = re.sub(r"[^\w\s]", " ", (s or "").lower())
    return {w for w in s.split() if len(w) > 1}


def similarity(a: str, b: str) -> float:
    A, B = _tokens(a), _tokens(b)
    if not A and not B:
        return 1.0
    if not A or not B:
        return 0.0
    inter = len(A & B)
    return inter / (len(A) + len(B) - inter)


def consensus_curve(j: float) -> float:
    if j <= 0:
        return 0.0
    return 100.0 if j >= 1 else (j ** 0.65) * 100


def _c(v) -> float:
    try:
        return max(0.0, min(100.0, float(v)))
    except (TypeError, ValueError):
        return 0.0


def score_confidence(self_conf, coherence, doc_likelihood, text_len, consensus=None, attempts=1, prev=0.0) -> float:
    s, co, dl = _c(self_conf), _c(coherence), _c(doc_likelihood)
    if dl < 20 or text_len < 8:
        return round(min(15, dl * 0.5 + text_len * 0.5), 1)
    base = 0.5 * consensus + 0.3 * s + 0.2 * co if consensus is not None else 0.6 * s + 0.4 * co
    if dl < 60:
        base *= 0.33 + 0.67 * max(0.0, min(1.0, (dl - 20) / 40))
    final = min(99.0, base + min(12, max(0, attempts - 1) * 4))
    if final < prev:
        final = min(99.0, prev + 2)
    return round(final, 1)


# ---------------- Text cleanup ----------------
_BLOCK_START = re.compile(r"^\s*(#|[-*+] |\d+[.)] |\||>|\$\$|\[\[FIGURE|!\[)")


def cleanup_markdown(md: str) -> str:
    """Rejoin hyphenated line breaks and reflow soft-wrapped paragraph lines."""
    md = (md or "").replace("\r\n", "\n")
    md = re.sub(r"(\w)-\n(\w)", r"\1\2", md)
    out: list[str] = []
    in_math = False
    for line in md.split("\n"):
        stripped = line.strip()
        if stripped.startswith("$$"):
            in_math = not in_math if stripped.count("$$") == 1 else in_math
            out.append(line)
            continue
        prev = out[-1] if out else ""
        can_join = (
            not in_math and stripped and prev.strip()
            and not _BLOCK_START.match(line) and not _BLOCK_START.match(prev)
            and not prev.rstrip().endswith("  ")
        )
        if can_join:
            out[-1] = prev.rstrip() + " " + stripped
        else:
            out.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()


def plain_text(md: str) -> str:
    t = re.sub(r"\[\[FIGURE:\d+\]\]", "", md or "")
    t = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", t)
    t = re.sub(r"^#+\s*", "", t, flags=re.M)
    return re.sub(r"[*_`|]", "", t)


# ---------------- Page reading ----------------
def pick_primary(settings: dict, keys: dict) -> str:
    p = settings.get("primary_provider") or "gemini"
    if keys.get(p):
        return p
    for alt in ("gemini", "openai", "anthropic"):
        if keys.get(alt):
            return alt
    return p


async def read_page(image_jpeg: bytes, settings: dict, prev_markdown: str | None = None,
                    attempts: int = 1, prev_conf: float = 0.0) -> dict:
    keys = await get_ai_keys()
    mode = settings.get("speed_mode") or "fast"
    if prev_markdown is not None:
        mode = "best"
    primary = pick_primary(settings, keys)
    others = [p for p in ("gemini", "openai", "anthropic") if p != primary and keys.get(p)]
    verifiers = [] if mode == "fast" else others[:1] if mode == "balanced" else others
    prompt = OCR_PROMPT
    if prev_markdown:
        prompt += ("\n\nA previous reading (may contain errors) is given below. Correct it against the image, "
                   "keep correct parts, fix mistakes, add anything missing:\n---\n" + prev_markdown[:8000] + "\n---")
    timeout = TIMEOUTS[mode]

    async def primary_call():
        raw = await call_ai(primary, MODELS[primary][mode], prompt, image_jpeg, timeout, want_json=True)
        return strip_json(raw)

    async def verify_call(p):
        return await call_ai(p, MODELS[p]["fast"], VERIFY_PROMPT, image_jpeg, TIMEOUTS["fast"], want_json=False)

    results = await asyncio.gather(primary_call(), *[verify_call(p) for p in verifiers], return_exceptions=True)
    main = results[0]
    if isinstance(main, Exception):
        raise main if isinstance(main, AIError) else AIError(str(main))
    md = cleanup_markdown(str(main.get("markdown") or ""))
    plain = plain_text(md)
    ran, sims = [], []
    for p, r in zip(verifiers, results[1:]):
        if isinstance(r, Exception):
            log.warning("verifier %s failed: %s", p, r)
            ran.append({"provider": p, "ok": False, "error": str(r)[:200]})
        else:
            sim = similarity(plain, r)
            sims.append(sim)
            ran.append({"provider": p, "ok": True, "similarity": round(sim * 100, 1)})
    consensus = consensus_curve(sum(sims) / len(sims)) if sims else None
    conf = score_confidence(main.get("self_confidence"), main.get("coherence_score"),
                            main.get("is_document_likelihood", 90), len(re.sub(r"\s", "", plain)),
                            consensus, attempts, prev_conf)
    figures = []
    for f in main.get("figures") or []:
        box = f.get("box_2d")
        if isinstance(box, list) and len(box) == 4:
            try:
                figures.append({"n": int(f.get("id")), "box_2d": [float(v) for v in box],
                                "caption": str(f.get("caption") or "")})
            except (TypeError, ValueError):
                continue
    pn = main.get("page_number")
    return {
        "markdown": md,
        "confidence": conf,
        "consensus": None if consensus is None else round(consensus, 1),
        "coherence_note": str(main.get("coherence_note") or "")[:200],
        "page_number": pn if isinstance(pn, int) else None,
        "figures": figures,
        "provider": primary,
        "model": MODELS[primary][mode],
        "mode": mode,
        "verifiers": ran,
    }


# ---------------- Free instructions ----------------
CHUNK_CHARS = 150_000


async def run_instruction(material: str, instruction: str, settings: dict) -> str:
    keys = await get_ai_keys()
    # Long material: Gemini Pro handles very long context in one go.
    if len(material) > CHUNK_CHARS and keys.get("gemini"):
        provider, model = "gemini", MODELS["gemini"]["balanced"]
    else:
        provider = pick_primary(settings, keys)
        model = MODELS[provider]["balanced"]
    chunks = [material] if provider == "gemini" or len(material) <= CHUNK_CHARS else [
        material[i:i + CHUNK_CHARS] for i in range(0, len(material), CHUNK_CHARS)]
    outs = []
    for i, ch in enumerate(chunks):
        part = f" (del {i + 1} av {len(chunks)})" if len(chunks) > 1 else ""
        prompt = f"INSTRUKTION:\n{instruction}\n\nMATERIAL{part}:\n{ch}"
        outs.append(await call_ai(provider, model, prompt, None, 600, want_json=False,
                                  system=INSTRUCTION_SYSTEM, max_tokens=16000))
    return "\n\n".join(o.strip() for o in outs)
