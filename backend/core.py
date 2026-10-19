"""Shared infrastructure: config, Mongo, auth (JWT), CommHub client."""
import os
import re
import hmac
import time
import uuid
import hashlib
import secrets
import logging
import datetime as dt
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

import httpx  # noqa: E402
import jwt  # noqa: E402
from fastapi import Header, HTTPException, Query  # noqa: E402
from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

log = logging.getLogger("copythat")

def _mongo_client() -> AsyncIOMotorClient:
    # Values pasted into hosting dashboards often carry quotes/whitespace.
    url = os.environ["MONGO_URL"].strip().strip('"').strip("'").strip()
    try:
        return AsyncIOMotorClient(url)
    except Exception as e:
        masked = re.sub(r"(://[^:/@]+:)[^@]*@", r"\1****@", url)
        raise RuntimeError(
            f"MONGO_URL är ogiltig ({e}). Värde (lösenord dolt): {masked} – Format: "
            "mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority . "
            "Specialtecken i lösenordet (/ @ : ? # %) måste URL-kodas, t.ex. / = %2F, @ = %40."
        ) from None


db = _mongo_client()[os.environ["DB_NAME"].strip()]

COMMHUB_BASE = "https://commhub.cloud/api"
COMMHUB_APP_ID = os.environ["COMMHUB_APP_ID"]
COMMHUB_API_KEY = os.environ["COMMHUB_API_KEY"]
JWT_SECRET = os.environ["JWT_SECRET"]
OWNER_EMAIL = os.environ.get("OWNER_EMAIL", "").strip().lower()
TEST_LOGIN_EMAIL = os.environ.get("TEST_LOGIN_EMAIL", "").strip().lower()
TEST_LOGIN_CODE = os.environ.get("TEST_LOGIN_CODE", "").strip()
TOKEN_DAYS = 30


def new_id() -> str:
    return uuid.uuid4().hex


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


# ---------------- CommHub ----------------
def _commhub_error(resp: httpx.Response) -> str:
    try:
        return str(resp.json().get("detail") or resp.text)[:300]
    except Exception:
        return resp.text[:300]


OTP_TTL = 600
OTP_MAX_ATTEMPTS = 5


def _hash_code(email: str, code: str) -> str:
    return hashlib.sha256(f"{JWT_SECRET}:{email}:{code}".encode()).hexdigest()


async def commhub_request_otp(email: str) -> None:
    """Generate a 6-digit single-use code and email it via CommHub (API-key authenticated)."""
    last = await db.login_codes.find_one({"email": email}, sort=[("created", -1)])
    if last and time.time() - last["created"] < 30:
        raise HTTPException(429, "Vänta en halv minut innan du begär en ny kod")
    code = f"{secrets.randbelow(1_000_000):06d}"
    html = (
        '<table role="presentation" width="100%"><tr><td style="padding:24px;font-family:Arial,sans-serif;color:#1F2328">'
        '<p style="font-size:16px">Din inloggningskod till CopyThat:</p>'
        f'<p style="font-size:32px;font-weight:bold;letter-spacing:6px">{code}</p>'
        '<p style="font-size:14px;color:#6B6F76">Koden gäller i 10 minuter och kan bara användas en gång. '
        'Om du inte försökte logga in kan du ignorera det här mejlet.</p></td></tr></table>'
    )
    try:
        await commhub_send_email(email, f"Din kod till CopyThat: {code}", html,
                                 f"Din inloggningskod till CopyThat: {code} (gäller i 10 minuter)")
    except RuntimeError:
        raise HTTPException(503, "Det gick inte att skicka koden just nu. Försök igen om en stund.")
    await db.login_codes.delete_many({"email": email})
    await db.login_codes.insert_one({"email": email, "hash": _hash_code(email, code), "created": time.time(),
                                     "attempts": 0})


async def commhub_send_email(to: str, subject: str, html: str, text: str) -> None:
    """Send an email via CommHub. Raises RuntimeError on failure."""
    try:
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(f"{COMMHUB_BASE}/email/send", headers={"X-API-Key": COMMHUB_API_KEY},
                             json={"app_id": COMMHUB_APP_ID, "to": [to], "subject": subject, "html_content": html,
                                   "text_content": text, "from_name": "CopyThat"})
    except httpx.HTTPError as e:
        log.error("CommHub email/send network error: %s", e)
        raise RuntimeError("network")
    if r.status_code >= 400:
        log.error("CommHub email/send %s: %s", r.status_code, r.text[:300])
        raise RuntimeError(str(r.status_code))


async def commhub_verify_otp(email: str, code: str) -> bool:
    rec = await db.login_codes.find_one({"email": email}, sort=[("created", -1)])
    if not rec or time.time() - rec["created"] > OTP_TTL or rec["attempts"] >= OTP_MAX_ATTEMPTS:
        return False
    if not hmac.compare_digest(rec["hash"], _hash_code(email, code)):
        await db.login_codes.update_one({"_id": rec["_id"]}, {"$inc": {"attempts": 1}})
        return False
    await db.login_codes.delete_many({"email": email})  # single use
    return True


async def commhub_upload(data: bytes, filename: str, content_type: str, category: str = "images") -> dict:
    """Upload bytes to CommHub file storage. Returns {"id", "url"}."""
    async with httpx.AsyncClient(timeout=120) as c:
        r = await c.post(
            f"{COMMHUB_BASE}/files/upload",
            params={"app_id": COMMHUB_APP_ID, "category": category},
            headers={"X-API-Key": COMMHUB_API_KEY},
            files={"file": (filename, data, content_type)},
        )
    if r.status_code >= 400:
        log.error("CommHub upload %s: %s", r.status_code, r.text[:300])
        raise RuntimeError(f"Fillagringen misslyckades ({r.status_code})")
    f = r.json().get("file") or {}
    return {"id": f.get("id"), "url": f.get("url") or r.json().get("url")}


async def commhub_delete(file_id: str | None) -> None:
    if not file_id:
        return
    try:
        async with httpx.AsyncClient(timeout=30) as c:
            await c.delete(f"{COMMHUB_BASE}/files/{file_id}", headers={"X-API-Key": COMMHUB_API_KEY})
    except Exception as e:  # deletion is best-effort
        log.warning("CommHub delete failed: %s", e)


async def fetch_bytes(url: str) -> bytes:
    async with httpx.AsyncClient(timeout=120, follow_redirects=True) as c:
        r = await c.get(url)
    r.raise_for_status()
    return r.content


# ---------------- AI keys ----------------
# Keys come from the CommHub keychain (GET /keychain/service/<name>?format=raw, X-API-Key with
# 'keychain' permission). backend/.env values are only used as fallback.
_keys_cache: dict = {"at": 0.0, "keys": {}, "ttl": 0}
KEYCHAIN_NAMES = {"openai": ["openai"], "gemini": ["gemini", "google", "google_gemini"],
                  "anthropic": ["anthropic", "claude"]}


async def _keychain_get(c: httpx.AsyncClient, name: str) -> str:
    r = await c.get(f"{COMMHUB_BASE}/keychain/service/{name}", params={"format": "raw"},
                    headers={"X-API-Key": COMMHUB_API_KEY})
    if r.status_code == 403:
        log.warning("CommHub keychain: %s", r.text[:200])
    if r.status_code >= 400:
        return ""
    return r.text.strip().strip('"')


async def get_ai_keys() -> dict:
    if time.time() - _keys_cache["at"] < _keys_cache["ttl"]:
        return _keys_cache["keys"]
    keys = {
        "openai": os.environ.get("OPENAI_API_KEY", "").strip(),
        "gemini": os.environ.get("GEMINI_API_KEY", "").strip(),
        "anthropic": os.environ.get("ANTHROPIC_API_KEY", "").strip(),
    }
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            # Map keychain services to providers via the listing (e.g. "openai-family" -> openai).
            names = {p: list(v) for p, v in KEYCHAIN_NAMES.items()}
            r = await c.get(f"{COMMHUB_BASE}/keychain/service", headers={"X-API-Key": COMMHUB_API_KEY})
            if r.status_code < 400:
                for s in r.json().get("services", []):
                    prov = "anthropic" if s.get("provider") == "claude" else s.get("provider")
                    if prov in names and not s.get("is_expired"):
                        names[prov].insert(0, s["service"])
            for p, cands in names.items():
                for n in dict.fromkeys(cands):
                    v = await _keychain_get(c, n)
                    if v:
                        keys[p] = v
                        break
    except httpx.HTTPError as e:
        log.warning("Could not fetch AI keys from CommHub keychain: %s", e)
    # Cache 5 min when all keys found, otherwise retry after 30 s (e.g. permission just granted).
    _keys_cache.update(at=time.time(), keys=keys, ttl=300 if all(keys.values()) else 30)
    return keys


# ---------------- Auth ----------------
def make_token(user: dict) -> str:
    exp = int(time.time()) + TOKEN_DAYS * 86400
    return jwt.encode({"sub": user["id"], "email": user["email"], "exp": exp}, JWT_SECRET, algorithm="HS256")


async def current_user(
    authorization: str | None = Header(None), token: str | None = Query(None)
) -> dict:
    raw = (authorization or "").removeprefix("Bearer ").strip() or (token or "")
    if not raw:
        raise HTTPException(401, "Inte inloggad")
    try:
        payload = jwt.decode(raw, JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(401, "Sessionen har gått ut, logga in igen")
    user = await db.users.find_one({"id": payload["sub"]}, {"_id": 0})
    if not user:
        raise HTTPException(401, "Kontot finns inte längre")
    return user


def require_owner(user: dict) -> None:
    if user.get("role") != "owner":
        raise HTTPException(403, "Endast ägaren kan göra detta")
