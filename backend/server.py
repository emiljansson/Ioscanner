from fastapi import FastAPI, APIRouter, HTTPException
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import re
import json
import logging
import asyncio
import uuid
import difflib
from pathlib import Path
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime, timezone

from emergentintegrations.llm.chat import LlmChat, UserMessage, ImageContent

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

EMERGENT_LLM_KEY = os.environ.get('EMERGENT_LLM_KEY', '')

app = FastAPI()
api_router = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


# ---------- Models ----------
class ScanRequest(BaseModel):
    image_base64: str


class RescanRequest(BaseModel):
    image_base64: str
    previous_text: str
    previous_confidence: float = 0.0
    attempts: int = 1


class ScanResult(BaseModel):
    id: str
    structured_text: str
    plain_text: str
    confidence_percent: float
    error_estimate_percent: float
    coherence_score: float
    coherence_note: str
    page_number: Optional[int] = None
    page_source: str = "missing"  # "found" | "inferred" | "missing"
    page_note: str = ""
    attempts: int
    created_at: str


class OrganizePage(BaseModel):
    id: str
    plain_text: str
    detected_page_number: Optional[int] = None
    capture_order: int


class OrganizeRequest(BaseModel):
    pages: List[OrganizePage]


class OrganizedPage(BaseModel):
    id: str
    page_number: int
    source: str  # "found" | "inferred"
    note: str = ""


# ---------- AI prompts ----------
GPT_OCR_PROMPT = (
    "You are a high-quality OCR engine for English/Swedish documents. "
    "Read the image and return STRICT JSON matching this schema:\n"
    "{\n"
    '  "structured_text": "<markdown text. Headings as **bold** on their own line, lists as -, keep line breaks>",\n'
    '  "plain_text": "<extracted text only, no markdown>",\n'
    '  "self_confidence": <0-100 how confident you are in the visual reading>,\n'
    '  "coherence_score": <0-100 how SEMANTICALLY PLAUSIBLE the text is as a real document: linguistic coherence, logical structure, sentence flow, context, plausible values – NOT just whether individual words are spelled correctly>,\n'
    '  "coherence_note": "<short ENGLISH note (max 120 chars) about any coherence issues, or empty>",\n'
    '  "page_number": <integer if a page number IS VISIBLE on the page (e.g. \\"Page 3\\", \\"3 (4)\\", \\"-3-\\", footer), otherwise null>,\n'
    '  "page_note": "<short ENGLISH note about how the page number was found, or empty>"\n'
    "}\n"
    "Find headings (short lines, titles, section labels) and mark them with **double asterisks**. "
    "Preserve order. Write nothing outside the JSON object. No code fences."
)

GPT_RESCAN_PROMPT_TMPL = (
    "You are a high-quality OCR engine. A previous reading produced the following "
    "text which may contain errors:\n---PREVIOUS---\n{prev}\n---END---\n\n"
    "Read the new image and CORRECT the previous text. Keep correct parts, "
    "fix misspellings, add missing words/lines if visible in the image. "
    "Return STRICT JSON:\n"
    "{{\n"
    '  "structured_text": "<markdown, headings as **bold**>",\n'
    '  "plain_text": "<plain text only>",\n'
    '  "self_confidence": <0-100>,\n'
    '  "coherence_score": <0-100>,\n'
    '  "coherence_note": "<English, max 120 chars or empty>",\n'
    '  "page_number": <integer if page number visible, else null>,\n'
    '  "page_note": "<short English note or empty>"\n'
    "}}\n"
    "No code fences, no text outside the JSON."
)

GEMINI_VERIFY_PROMPT = (
    "Read the image and return ONLY the verbatim text content as plain text. "
    "No commentary, no markdown, no JSON. Preserve line breaks."
)

ORGANIZE_PROMPT = (
    "You receive a list of scanned pages in the order they were photographed. "
    "Some already have a detected page_number, others don't. Your task:\n"
    "1. Use page_number if present and plausible given the content.\n"
    "2. For pages without a detected number: guess the most likely number based on "
    "the neighbours' numbers + the text's content/context.\n"
    "3. If the most plausible integer fits in the sequence between the neighbours, "
    "use it. Otherwise pick the next free integer in the sequence.\n"
    "4. Two pages must NEVER share the same final number – pick the next free instead.\n"
    "5. source must be \"found\" if we kept the already-detected number, otherwise \"inferred\".\n"
    "6. note: one short ENGLISH sentence justifying the choice if source=inferred, empty otherwise.\n\n"
    "Return STRICT JSON without code fences:\n"
    '{ "pages": [ { "id": "<same id>", "page_number": <integer>, "source": "found|inferred", "note": "<en>" } ] }'
)


# ---------- Helpers ----------
def _strip_json(raw: str) -> str:
    raw = raw.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```[a-zA-Z]*\n?", "", raw)
        raw = re.sub(r"\n?```$", "", raw)
    return raw.strip()


def _normalize(t: str) -> str:
    return re.sub(r"\s+", " ", (t or "").lower()).strip()


def _similarity(a: str, b: str) -> float:
    a, b = _normalize(a), _normalize(b)
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def _to_int_or_none(v) -> Optional[int]:
    try:
        if v is None or v == "" or v is False:
            return None
        return int(v)
    except Exception:
        return None


async def _gpt_ocr(image_b64: str, prompt: str) -> dict:
    chat = LlmChat(
        api_key=EMERGENT_LLM_KEY,
        session_id=f"ocr-gpt-{uuid.uuid4()}",
        system_message="You output only valid JSON."
    ).with_model("openai", "gpt-5.2")
    msg = UserMessage(text=prompt, file_contents=[ImageContent(image_base64=image_b64)])
    raw = await chat.send_message(msg)
    cleaned = _strip_json(str(raw))
    try:
        return json.loads(cleaned)
    except Exception as e:
        logger.warning(f"GPT JSON parse failed, returning raw text. err={e} raw={cleaned[:200]}")
        return {
            "structured_text": cleaned,
            "plain_text": re.sub(r"\*\*", "", cleaned),
            "self_confidence": 50,
            "coherence_score": 50,
            "coherence_note": "",
            "page_number": None,
            "page_note": "",
        }


async def _gemini_text(image_b64: str) -> str:
    chat = LlmChat(
        api_key=EMERGENT_LLM_KEY,
        session_id=f"ocr-gem-{uuid.uuid4()}",
        system_message="You are a precise OCR engine."
    ).with_model("gemini", "gemini-3.1-pro-preview")
    msg = UserMessage(text=GEMINI_VERIFY_PROMPT, file_contents=[ImageContent(image_base64=image_b64)])
    raw = await chat.send_message(msg)
    return str(raw).strip()


def _confidence(gpt_self: float, coherence: float, gemini_text: str, gpt_plain: str, attempts: int) -> float:
    sim = _similarity(gemini_text, gpt_plain) * 100.0
    base = 0.45 * sim + 0.25 * float(gpt_self or 0) + 0.30 * float(coherence or 0)
    bonus = min(12.0, max(0, attempts - 1) * 4.0)
    final = min(99.0, base + bonus)
    return round(final, 1)


def _build_scan_result(gpt_res: dict, gem_text: str, attempts: int, prev_conf: float = 0.0) -> dict:
    structured = gpt_res.get("structured_text", "")
    plain = gpt_res.get("plain_text", "") or re.sub(r"\*\*", "", structured)
    self_conf = float(gpt_res.get("self_confidence", 60) or 60)
    coherence = float(gpt_res.get("coherence_score", 60) or 60)
    coh_note = str(gpt_res.get("coherence_note", "") or "")
    page_num = _to_int_or_none(gpt_res.get("page_number"))
    page_note = str(gpt_res.get("page_note", "") or "")

    confidence = _confidence(self_conf, coherence, gem_text or "", plain, attempts=attempts)
    if confidence < prev_conf:
        confidence = round(min(99.0, prev_conf + 2.0), 1)
    error = round(max(0.0, 100.0 - confidence), 1)

    return {
        "id": str(uuid.uuid4()),
        "structured_text": structured,
        "plain_text": plain,
        "confidence_percent": confidence,
        "error_estimate_percent": error,
        "coherence_score": round(coherence, 1),
        "coherence_note": coh_note,
        "page_number": page_num,
        "page_source": "found" if page_num is not None else "missing",
        "page_note": page_note,
        "attempts": attempts,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


# ---------- Routes ----------
@api_router.get("/")
async def root():
    return {"message": "Jawel Scanner API"}


@api_router.get("/health")
async def health():
    return {"ok": True, "llm_key": bool(EMERGENT_LLM_KEY)}


@api_router.post("/ocr/scan", response_model=ScanResult)
async def ocr_scan(req: ScanRequest):
    if not EMERGENT_LLM_KEY:
        raise HTTPException(500, "EMERGENT_LLM_KEY missing")
    if not req.image_base64:
        raise HTTPException(400, "image_base64 required")
    try:
        gpt_task = _gpt_ocr(req.image_base64, GPT_OCR_PROMPT)
        gem_task = _gemini_text(req.image_base64)
        gpt_res, gem_text = await asyncio.gather(gpt_task, gem_task, return_exceptions=True)
        if isinstance(gpt_res, Exception):
            raise HTTPException(502, f"GPT-5.2 OCR failed: {gpt_res}")
        if isinstance(gem_text, Exception):
            gem_text = ""
        scan = _build_scan_result(gpt_res, gem_text or "", attempts=1)
        await db.scans.insert_one({**scan, "gemini_text": gem_text or ""})
        return ScanResult(**scan)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("scan failed")
        raise HTTPException(500, f"OCR error: {e}")


@api_router.post("/ocr/rescan", response_model=ScanResult)
async def ocr_rescan(req: RescanRequest):
    if not EMERGENT_LLM_KEY:
        raise HTTPException(500, "EMERGENT_LLM_KEY missing")
    if not req.image_base64:
        raise HTTPException(400, "image_base64 required")
    prompt = GPT_RESCAN_PROMPT_TMPL.format(prev=req.previous_text[:6000])
    try:
        gpt_task = _gpt_ocr(req.image_base64, prompt)
        gem_task = _gemini_text(req.image_base64)
        gpt_res, gem_text = await asyncio.gather(gpt_task, gem_task, return_exceptions=True)
        if isinstance(gpt_res, Exception):
            raise HTTPException(502, f"GPT-5.2 rescan failed: {gpt_res}")
        if isinstance(gem_text, Exception):
            gem_text = ""
        attempts = max(2, int(req.attempts or 1) + 1)
        scan = _build_scan_result(
            gpt_res, gem_text or "",
            attempts=attempts,
            prev_conf=float(req.previous_confidence or 0),
        )
        await db.scans.insert_one({**scan, "gemini_text": gem_text or ""})
        return ScanResult(**scan)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("rescan failed")
        raise HTTPException(500, f"OCR rescan error: {e}")


@api_router.post("/ocr/organize")
async def ocr_organize(req: OrganizeRequest):
    """Take all scanned pages, return them ordered with intelligent page numbering.
    AI fills in 'inferred' numbers for pages where none was detected on the image.
    Falls back to the capture order with simple sequential numbering if AI fails.
    """
    if not req.pages:
        return {"pages": []}

    # Build compact payload for the LLM. Trim plain_text to keep payload small.
    items = []
    for p in req.pages:
        items.append({
            "id": p.id,
            "capture_order": p.capture_order,
            "detected_page_number": p.detected_page_number,
            "text_excerpt": (p.plain_text or "")[:600],
        })

    # If only one page and no detection -> just call it page 1
    if len(items) == 1 and items[0]["detected_page_number"] is None:
        return {"pages": [{
            "id": items[0]["id"],
            "page_number": 1,
            "source": "inferred",
            "note": "Only one page – numbered as 1.",
        }]}

    user_text = ORGANIZE_PROMPT + "\n\nSidor:\n" + json.dumps(items, ensure_ascii=False)
    try:
        if not EMERGENT_LLM_KEY:
            raise RuntimeError("EMERGENT_LLM_KEY missing")
        chat = LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=f"organize-{uuid.uuid4()}",
            system_message="You output only valid JSON. No commentary.",
        ).with_model("openai", "gpt-5.2")
        raw = await chat.send_message(UserMessage(text=user_text))
        data = json.loads(_strip_json(str(raw)))
        pages = data.get("pages", [])
        # Dedupe page_number assignments
        used: set[int] = set()
        out: List[dict] = []
        for p in pages:
            n = _to_int_or_none(p.get("page_number"))
            if n is None or n in used:
                # find next free positive int
                n = max(used) + 1 if used else 1
                while n in used:
                    n += 1
                p["source"] = "inferred"
                p["note"] = (p.get("note") or "") + " (adjusted to avoid duplicate)"
            used.add(n)
            out.append({
                "id": str(p.get("id", "")),
                "page_number": n,
                "source": p.get("source") or "inferred",
                "note": p.get("note") or "",
            })
        return {"pages": out}
    except Exception as e:
        logger.warning(f"organize fallback: {e}")
        # Deterministic fallback: use detected number if any, else fill gaps sequentially
        used: set[int] = {p["detected_page_number"] for p in items if p["detected_page_number"]}
        out_fb: List[dict] = []
        next_free = 1
        for it in sorted(items, key=lambda x: x["capture_order"]):
            n = it["detected_page_number"]
            src = "found"
            note = ""
            if n is None:
                while next_free in used:
                    next_free += 1
                n = next_free
                used.add(n)
                src = "inferred"
                note = "No page number found – assigned automatically."
                next_free += 1
            out_fb.append({"id": it["id"], "page_number": n, "source": src, "note": note})
        return {"pages": out_fb}


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
