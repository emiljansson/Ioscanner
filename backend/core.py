"""Shared infrastructure: config, Mongo, auth (JWT), CommHub client."""
import os
import time
import uuid
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

db = AsyncIOMotorClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]

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


async def commhub_request_otp(email: str) -> None:
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(f"{COMMHUB_BASE}/public/{COMMHUB_APP_ID}/request-otp", json={"email": email})
    if r.status_code >= 400:
        log.error("CommHub request-otp %s: %s", r.status_code, r.text[:300])
        raise HTTPException(502, f"Kunde inte skicka koden: {_commhub_error(r)}")


async def commhub_verify_otp(email: str, code: str) -> bool:
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(
            f"{COMMHUB_BASE}/public/{COMMHUB_APP_ID}/verify-otp", json={"email": email, "code": code}
        )
    if r.status_code in (400, 401, 403, 404, 422):
        return False
    if r.status_code >= 400:
        log.error("CommHub verify-otp %s: %s", r.status_code, r.text[:300])
        raise HTTPException(502, "Inloggningstjänsten svarar inte just nu")
    return bool(r.json().get("token"))


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
# Keys come from CommHub once that endpoint exists (COMMHUB_AI_KEYS_PATH, e.g.
# "/llm-settings/keys"); until then they fall back to backend/.env.
_keys_cache: dict = {"at": 0.0, "keys": {}}


async def get_ai_keys() -> dict:
    if time.time() - _keys_cache["at"] < 300:
        return _keys_cache["keys"]
    keys = {
        "openai": os.environ.get("OPENAI_API_KEY", "").strip(),
        "gemini": os.environ.get("GEMINI_API_KEY", "").strip(),
        "anthropic": os.environ.get("ANTHROPIC_API_KEY", "").strip(),
    }
    path = os.environ.get("COMMHUB_AI_KEYS_PATH", "").strip()
    if path:
        try:
            async with httpx.AsyncClient(timeout=15) as c:
                r = await c.get(
                    f"{COMMHUB_BASE}{path}",
                    params={"app_id": COMMHUB_APP_ID},
                    headers={"X-API-Key": COMMHUB_API_KEY},
                )
            if r.status_code < 400:
                data = r.json()
                for p in keys:
                    v = data.get(p) or data.get(f"{p}_api_key") or data.get(f"{p}_key")
                    if isinstance(v, str) and v.strip():
                        keys[p] = v.strip()
        except Exception as e:
            log.warning("Could not fetch AI keys from CommHub: %s", e)
    _keys_cache.update(at=time.time(), keys=keys)
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
