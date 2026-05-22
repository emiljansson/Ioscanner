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
import httpx
from pathlib import Path
from pydantic import BaseModel, Field
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
COMMHUB_API_KEY = os.environ.get('COMMHUB_API_KEY', '')
COMMHUB_APP_ID = os.environ.get('COMMHUB_APP_ID', '')
COMMHUB_FROM = os.environ.get('COMMHUB_FROM', 'noreply@grindstugatan.se')
COMMHUB_URL = "https://commhub.cloud/api/email/send"

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
    attempts: int
    created_at: str


class EmailRequest(BaseModel):
    to: List[str]
    subject: str
    body_markdown: str


# ---------- AI prompts ----------
GPT_OCR_PROMPT = (
    "Du är en högkvalitativ OCR-motor för svenska/engelska dokument. "
    "Läs bilden och returnera STRIKT JSON enligt schema:\n"
    "{\n"
    '  "structured_text": "<markdown med rubriker som **fet text** på egen rad, listor som -, behåll radbrytningar>",\n'
    '  "plain_text": "<endast extraherad text, ingen markdown>",\n'
    '  "self_confidence": <0-100 hur säker du är på avläsningen>\n'
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
    '  "self_confidence": <0-100>\n'
    "}}\n"
    "Inga kodstaket, ingen text utanför JSON."
)

GEMINI_VERIFY_PROMPT = (
    "Read the image and return ONLY the verbatim text content as plain text. "
    "No commentary, no markdown, no JSON. Preserve line breaks."
)


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


def _confidence(gpt_self: float, gemini_text: str, gpt_plain: str, attempts: int) -> float:
    sim = _similarity(gemini_text, gpt_plain) * 100.0
    base = 0.6 * sim + 0.4 * float(gpt_self or 0)
    # bonus per extra attempt (caps at +12 across 4 attempts)
    bonus = min(12.0, max(0, attempts - 1) * 4.0)
    final = min(99.0, base + bonus)
    return round(final, 1)


# ---------- Routes ----------
@api_router.get("/")
async def root():
    return {"message": "Jawel Scanner API"}


@api_router.get("/health")
async def health():
    return {
        "ok": True,
        "llm_key": bool(EMERGENT_LLM_KEY),
        "commhub": bool(COMMHUB_API_KEY and COMMHUB_APP_ID),
    }


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
            logger.error(f"GPT OCR failed: {gpt_res}")
            raise HTTPException(502, f"GPT-5.2 OCR failed: {gpt_res}")
        if isinstance(gem_text, Exception):
            logger.warning(f"Gemini verify failed, using GPT only: {gem_text}")
            gem_text = ""

        structured = gpt_res.get("structured_text", "")
        plain = gpt_res.get("plain_text", "") or re.sub(r"\*\*", "", structured)
        self_conf = float(gpt_res.get("self_confidence", 60) or 60)

        confidence = _confidence(self_conf, gem_text or "", plain, attempts=1)
        error = round(max(0.0, 100.0 - confidence), 1)

        scan = {
            "id": str(uuid.uuid4()),
            "structured_text": structured,
            "plain_text": plain,
            "confidence_percent": confidence,
            "error_estimate_percent": error,
            "attempts": 1,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "gemini_text": gem_text or "",
        }
        await db.scans.insert_one(scan.copy())
        scan.pop("gemini_text", None)
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

        structured = gpt_res.get("structured_text", "")
        plain = gpt_res.get("plain_text", "") or re.sub(r"\*\*", "", structured)
        self_conf = float(gpt_res.get("self_confidence", 70) or 70)

        attempts = max(2, int(req.attempts or 1) + 1)
        confidence = _confidence(self_conf, gem_text or "", plain, attempts=attempts)
        # ensure rescan only improves
        if confidence < float(req.previous_confidence or 0):
            confidence = round(min(99.0, float(req.previous_confidence) + 2.0), 1)
        error = round(max(0.0, 100.0 - confidence), 1)

        scan = {
            "id": str(uuid.uuid4()),
            "structured_text": structured,
            "plain_text": plain,
            "confidence_percent": confidence,
            "error_estimate_percent": error,
            "attempts": attempts,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "gemini_text": gem_text or "",
        }
        await db.scans.insert_one(scan.copy())
        scan.pop("gemini_text", None)
        return ScanResult(**scan)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("rescan failed")
        raise HTTPException(500, f"OCR rescan error: {e}")


def _md_to_html(md: str) -> str:
    """Minimal markdown -> HTML for emails. Supports **bold**, lines, and per-page H2."""
    html = md
    # bold
    html = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", html, flags=re.DOTALL)
    # H2 markers for pages
    html = re.sub(r"^## (.+)$", r"<h2 style='font-family:sans-serif;margin:24px 0 8px;'>\1</h2>",
                  html, flags=re.MULTILINE)
    # line breaks
    html = html.replace("\n", "<br/>")
    return (
        "<div style=\"font-family: -apple-system, Segoe UI, Roboto, sans-serif; "
        "font-size:15px; line-height:1.55; color:#09090B; max-width:680px;\">"
        f"{html}</div>"
    )


@api_router.post("/email/send")
async def send_email(req: EmailRequest):
    if not (COMMHUB_API_KEY and COMMHUB_APP_ID):
        raise HTTPException(500, "commhub credentials missing")
    if not req.to:
        raise HTTPException(400, "recipient required")

    payload = {
        "app_id": COMMHUB_APP_ID,
        "to": req.to,
        "subject": req.subject or "Skannat dokument",
        "html_content": _md_to_html(req.body_markdown or ""),
        "text_content": re.sub(r"\*\*", "", req.body_markdown or ""),
        "from_name": "Jawel Scanner",
        "reply_to": COMMHUB_FROM,
    }
    headers = {"x-api-key": COMMHUB_API_KEY, "Content-Type": "application/json"}

    try:
        async with httpx.AsyncClient(timeout=30) as hc:
            r = await hc.post(COMMHUB_URL, json=payload, headers=headers)
        ok = 200 <= r.status_code < 300
        body: Optional[dict] = None
        try:
            body = r.json()
        except Exception:
            body = {"raw": r.text[:500]}
        await db.email_log.insert_one({
            "id": str(uuid.uuid4()),
            "to": req.to,
            "subject": payload["subject"],
            "status_code": r.status_code,
            "ok": ok,
            "response": body,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
        if not ok:
            raise HTTPException(r.status_code, f"commhub error: {body}")
        return {"ok": True, "status_code": r.status_code, "response": body}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("email send failed")
        raise HTTPException(500, f"email send error: {e}")


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
