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
    "Du är en högkvalitativ OCR-motor för svenska/engelska dokument. "
    "Läs bilden och returnera STRIKT JSON enligt schema:\n"
    "{\n"
    '  "structured_text": "<markdown med rubriker som **fet text** på egen rad, listor som -, behåll radbrytningar>",\n'
    '  "plain_text": "<endast extraherad text, ingen markdown>",\n'
    '  "self_confidence": <0-100 hur säker du är på avläsningen visuellt>,\n'
    '  "coherence_score": <0-100 hur SEMANTISKT RIMLIG texten är som ett verkligt dokument>,\n'
    '  "coherence_note": "<max 120 tecken eller tomt>",\n'
    '  "page_number": <heltal om ett sidnummer SYNS på sidan (t.ex. \\"Sida 3\\", \\"3 (4)\\", \\"-3-\\", sidfot etc.), annars null>,\n'
    '  "page_note": "<kort svensk notering om hur sidnumret hittades, eller tomt>"\n'
    "}\n"
    "Hitta rubriker (kortare rader, titlar, sektioner) och markera dem med **dubbla asterisker**. "
    "Bevara ordning. Skriv inget utanför JSON-objektet. Inga kodstaket."
)

GPT_RESCAN_PROMPT_TMPL = (
    "Du är en högkvalitativ OCR-motor. En tidigare avläsning gav följande text "
    "som kan innehålla fel:\n---FÖREGÅENDE---\n{prev}\n---SLUT---\n\n"
    "Läs den nya bilden och KORRIGERA tidigare text. Behåll korrekta delar, "
    "rätta felstavningar, lägg till saknade ord/rader om de syns i bilden. "
    "Returnera STRIKT JSON:\n"
    "{{\n"
    '  "structured_text": "<markdown, rubriker som **fet text**>",\n'
    '  "plain_text": "<endast text>",\n'
    '  "self_confidence": <0-100>,\n'
    '  "coherence_score": <0-100>,\n'
    '  "coherence_note": "<max 120 tecken eller tomt>",\n'
    '  "page_number": <heltal om sidnummer syns, annars null>,\n'
    '  "page_note": "<kort notering eller tomt>"\n'
    "}}\n"
    "Inga kodstaket, ingen text utanför JSON."
)

GEMINI_VERIFY_PROMPT = (
    "Read the image and return ONLY the verbatim text content as plain text. "
    "No commentary, no markdown, no JSON. Preserve line breaks."
)

ORGANIZE_PROMPT = (
    "Du får en lista skannade sidor i den ordning de fotograferades. Vissa har redan "
    "ett upptäckt sidnummer, andra saknar det. Din uppgift:\n"
    "1. Använd page_number om det finns och verkar rimligt utifrån innehållet.\n"
    "2. För sidor utan upptäckt nummer: gissa det troligaste numret utifrån grannarnas "
    "nummer + textens innehåll/sammanhang (t.ex. fortsatt mening, samma rubrik, datumlogik).\n"
    "3. Om det rimligaste numret är ett heltal som passar i sekvensen mellan grannarna, "
    "använd det. Annars välj nästa lediga heltal i sekvensen.\n"
    "4. Två sidor får ALDRIG samma slutliga nummer – välj då nästa lediga.\n"
    "5. source ska vara \"found\" om vi behöll det redan upptäckta numret, annars \"inferred\".\n"
    "6. note: 1 mening på svenska som motiverar valet om source=inferred, annars tom.\n\n"
    "Returnera STRIKT JSON utan kodstaket:\n"
    '{ "pages": [ { "id": "<samma id>", "page_number": <heltal>, "source": "found|inferred", "note": "<sv>" } ] }'
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
            "note": "Endast en sida – numreras som 1.",
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
                p["note"] = (p.get("note") or "") + " (justerad för att undvika dubblett)"
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
                note = "Inget sidnummer hittades – tilldelat automatiskt."
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
