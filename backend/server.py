"""CopyThat API – AI-OCR for study material."""
import re
import secrets
import shutil
from pathlib import Path

from fastapi import FastAPI, APIRouter, Depends, HTTPException, UploadFile, File, Form, BackgroundTasks, Header
from fastapi.responses import Response
from pydantic import BaseModel, Field
from starlette.middleware.cors import CORSMiddleware

from core import (db, new_id, now, log, current_user, require_owner, make_token, get_ai_keys,
                  commhub_request_otp, commhub_verify_otp, commhub_delete, commhub_upload, commhub_send_email, OWNER_EMAIL,
                  TEST_LOGIN_EMAIL, TEST_LOGIN_CODE)
from ai import MODELS, LABELS, run_instruction, AIError, model_for, list_models
import pipeline
from export import document_markdown, build_files, make_zip, safe_name, strip_html

app = FastAPI(title="CopyThat")
api = APIRouter(prefix="/api")
UPLOADS = Path(__file__).parent / "uploads_tmp"
UPLOADS.mkdir(exist_ok=True)
MAX_UPLOAD_BYTES = 500 * 1024 * 1024
REF_CAPTIONS = re.compile(r"!\[([^\]]*)\]\(fig:([a-f0-9]+)\)")


def clean(doc: dict | None) -> dict | None:
    if doc:
        doc.pop("_id", None)
    return doc


async def own(collection: str, item_id: str, user: dict) -> dict:
    doc = await db[collection].find_one({"id": item_id, "user_id": user["id"]}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Hittades inte")
    return doc


# ---------------- Auth ----------------
class EmailIn(BaseModel):
    email: str


class VerifyIn(BaseModel):
    email: str
    code: str


def norm_email(e: str) -> str:
    e = (e or "").strip().lower()
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", e):
        raise HTTPException(422, "Ange en giltig e-postadress")
    return e


@api.post("/auth/request-code")
async def request_code(body: EmailIn):
    email = norm_email(body.email)
    if not await db.users.find_one({"email": email}):
        raise HTTPException(403, "Den här e-postadressen är inte inbjuden till CopyThat")
    if TEST_LOGIN_EMAIL and email == TEST_LOGIN_EMAIL:
        return {"ok": True}
    await commhub_request_otp(email)
    return {"ok": True}


@api.post("/auth/verify")
async def verify_code(body: VerifyIn):
    email = norm_email(body.email)
    code = re.sub(r"\D", "", body.code or "")
    user = await db.users.find_one({"email": email}, {"_id": 0})
    if not user:
        raise HTTPException(403, "Den här e-postadressen är inte inbjuden till CopyThat")
    if TEST_LOGIN_EMAIL and email == TEST_LOGIN_EMAIL:
        ok = code == TEST_LOGIN_CODE
    else:
        ok = len(code) == 6 and await commhub_verify_otp(email, code)
    if not ok:
        raise HTTPException(401, "Fel eller utgången kod – begär en ny kod")
    await db.users.update_one({"id": user["id"]}, {"$set": {"last_login": now()}})
    return {"token": make_token(user), "user": user}


@api.get("/auth/me")
async def me(user: dict = Depends(current_user)):
    return user


# ---------------- Admin: users ----------------
@api.get("/admin/users")
async def list_users(user: dict = Depends(current_user)):
    require_owner(user)
    return await db.users.find({}, {"_id": 0}).sort("created_at", 1).to_list(200)


@api.post("/admin/users")
async def invite_user(body: EmailIn, user: dict = Depends(current_user)):
    require_owner(user)
    email = norm_email(body.email)
    if await db.users.find_one({"email": email}):
        raise HTTPException(409, "Användaren finns redan")
    u = {"id": new_id(), "email": email, "role": "member", "created_at": now(), "invited_by": user["email"]}
    await db.users.insert_one(dict(u))
    return u


@api.delete("/admin/users/{user_id}")
async def remove_user(user_id: str, user: dict = Depends(current_user)):
    require_owner(user)
    if user_id == user["id"]:
        raise HTTPException(400, "Du kan inte ta bort dig själv")
    await db.users.delete_one({"id": user_id, "role": {"$ne": "owner"}})
    return {"ok": True}


# ---------------- Settings ----------------
class ModelOverride(BaseModel):
    provider: str
    mode: str
    model: str | None = None  # None = back to the default


class SettingsIn(BaseModel):
    speed_mode: str | None = None
    primary_provider: str | None = None
    model_override: ModelOverride | None = None


@api.get("/settings")
async def get_settings(user: dict = Depends(current_user)):
    s = await pipeline.settings_doc()
    keys = await get_ai_keys()
    return {
        "speed_mode": s.get("speed_mode", "fast"),
        "primary_provider": s.get("primary_provider", "gemini"),
        "providers": [{"id": p, "label": LABELS[p], "has_key": bool(keys.get(p)),
                       "models": {m: model_for(p, m, s) for m in MODELS[p]}, "default_models": MODELS[p]}
                      for p in MODELS],
        "is_owner": user.get("role") == "owner",
    }


@api.put("/settings")
async def put_settings(body: SettingsIn, user: dict = Depends(current_user)):
    require_owner(user)
    upd = {}
    if body.speed_mode in ("fast", "balanced", "best"):
        upd["speed_mode"] = body.speed_mode
    if body.primary_provider in MODELS:
        upd["primary_provider"] = body.primary_provider
    unset = {}
    o = body.model_override
    if o and o.provider in MODELS and o.mode in MODELS[o.provider]:
        field = f"model_overrides.{o.provider}.{o.mode}"
        if o.model and o.model != MODELS[o.provider][o.mode]:
            if not re.match(r"^[\w.\-:]{2,80}$", o.model):
                raise HTTPException(400, "Ogiltigt modellnamn")
            upd[field] = o.model
        else:
            unset[field] = ""
    ops = {k: v for k, v in (("$set", upd), ("$unset", unset)) if v}
    if ops:
        await db.settings.update_one({"id": "global"}, ops, upsert=True)
    return await get_settings(user)


@api.get("/settings/models/{provider}")
async def available_models(provider: str, user: dict = Depends(current_user)):
    require_owner(user)
    if provider not in MODELS:
        raise HTTPException(404, "Okänd AI-tjänst")
    try:
        return {"models": await list_models(provider)}
    except AIError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        log.warning("list models %s failed: %s", provider, e)
        raise HTTPException(502, f"Kunde inte hämta modellerna från {LABELS[provider]}")


# ---------------- Courses ----------------
class NameIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)


@api.get("/courses")
async def list_courses(user: dict = Depends(current_user)):
    courses = await db.courses.find({"user_id": user["id"]}, {"_id": 0}).sort("name", 1).to_list(500)
    for c in courses:
        c["document_count"] = await db.documents.count_documents({"course_id": c["id"]})
    return courses


@api.post("/courses")
async def create_course(body: NameIn, user: dict = Depends(current_user)):
    c = {"id": new_id(), "user_id": user["id"], "name": body.name.strip(), "created_at": now()}
    await db.courses.insert_one(dict(c))
    return {**c, "document_count": 0}


@api.patch("/courses/{course_id}")
async def rename_course(course_id: str, body: NameIn, user: dict = Depends(current_user)):
    await own("courses", course_id, user)
    await db.courses.update_one({"id": course_id}, {"$set": {"name": body.name.strip()}})
    return await own("courses", course_id, user)


async def delete_document_data(doc_id: str) -> None:
    async for p in db.pages.find({"document_id": doc_id}, {"_id": 0}):
        await commhub_delete(p.get("image_file_id"))
        for f in p.get("figures", []):
            await commhub_delete(f.get("file_id"))
    d = await db.documents.find_one({"id": doc_id}, {"_id": 0, "email_zip_id": 1})
    await commhub_delete((d or {}).get("email_zip_id"))
    await db.pages.delete_many({"document_id": doc_id})
    await db.documents.delete_one({"id": doc_id})


@api.delete("/courses/{course_id}")
async def delete_course(course_id: str, bg: BackgroundTasks, user: dict = Depends(current_user)):
    await own("courses", course_id, user)
    ids = [d["id"] async for d in db.documents.find({"course_id": course_id}, {"id": 1})]
    await db.documents.update_many({"course_id": course_id}, {"$set": {"deleting": True}})
    await db.courses.delete_one({"id": course_id})
    for i in ids:
        bg.add_task(delete_document_data, i)
    return {"ok": True}


# ---------------- Documents ----------------
class DocIn(BaseModel):
    course_id: str
    title: str = Field(min_length=1, max_length=200)


class DocPatch(BaseModel):
    title: str | None = None
    course_id: str | None = None
    markdown: str | None = None


async def doc_summary(d: dict) -> dict:
    if d.get("kind") != "generated":
        counts = {}
        async for row in db.pages.aggregate([{"$match": {"document_id": d["id"]}},
                                             {"$group": {"_id": "$status", "n": {"$sum": 1}}}]):
            counts[row["_id"]] = row["n"]
        d["page_counts"] = counts
        d["page_total"] = sum(counts.values())
    d.pop("markdown", None) if d.get("kind") != "generated" else None
    return d


@api.get("/documents")
async def list_documents(course_id: str | None = None, user: dict = Depends(current_user)):
    q = {"user_id": user["id"], "deleting": {"$ne": True}}
    if course_id:
        q["course_id"] = course_id
    docs = await db.documents.find(q, {"_id": 0, "markdown": 0}).sort("updated_at", -1).to_list(1000)
    return [await doc_summary(d) for d in docs]


@api.post("/documents")
async def create_document(body: DocIn, user: dict = Depends(current_user)):
    await own("courses", body.course_id, user)
    d = {"id": new_id(), "user_id": user["id"], "course_id": body.course_id, "title": body.title.strip(),
         "kind": "scan", "status": "ready", "created_at": now(), "updated_at": now()}
    await db.documents.insert_one(dict(d))
    return await doc_summary(d)


@api.get("/documents/{doc_id}")
async def get_document(doc_id: str, user: dict = Depends(current_user)):
    d = await own("documents", doc_id, user)
    pages = await db.pages.find({"document_id": doc_id}, {"_id": 0}).sort("order", 1).to_list(2000)
    d = await doc_summary(d)
    d["pages"] = pages
    return d


@api.patch("/documents/{doc_id}")
async def patch_document(doc_id: str, body: DocPatch, user: dict = Depends(current_user)):
    d = await own("documents", doc_id, user)
    upd = {"updated_at": now()}
    if body.title and body.title.strip():
        upd["title"] = body.title.strip()
    if body.course_id:
        await own("courses", body.course_id, user)
        upd["course_id"] = body.course_id
    if body.markdown is not None and d.get("kind") == "generated":
        upd["markdown"] = body.markdown
    await db.documents.update_one({"id": doc_id}, {"$set": upd})
    return await get_document(doc_id, user)


@api.delete("/documents/{doc_id}")
async def delete_document(doc_id: str, bg: BackgroundTasks, user: dict = Depends(current_user)):
    await own("documents", doc_id, user)
    await db.documents.update_one({"id": doc_id}, {"$set": {"deleting": True}})
    bg.add_task(delete_document_data, doc_id)
    return {"ok": True}


@api.post("/documents/{doc_id}/sort")
async def sort_document(doc_id: str, user: dict = Depends(current_user)):
    await own("documents", doc_id, user)
    await pipeline.sort_pages(doc_id)
    return await get_document(doc_id, user)


class ReorderIn(BaseModel):
    page_ids: list[str]


@api.post("/documents/{doc_id}/reorder")
async def reorder(doc_id: str, body: ReorderIn, user: dict = Depends(current_user)):
    await own("documents", doc_id, user)
    for i, pid in enumerate(body.page_ids):
        await db.pages.update_one({"id": pid, "document_id": doc_id}, {"$set": {"order": i}})
    return await get_document(doc_id, user)


@api.post("/inbox")
async def inbox(user: dict = Depends(current_user)):
    """Default course/document for mobile captures."""
    course = await db.courses.find_one({"user_id": user["id"], "name": "Inkorg"}, {"_id": 0})
    if not course:
        course = {"id": new_id(), "user_id": user["id"], "name": "Inkorg", "created_at": now()}
        await db.courses.insert_one(dict(course))
    title = f"Mobilscanningar {now()[:10]}"
    doc = await db.documents.find_one({"course_id": course["id"], "title": title, "deleting": {"$ne": True}},
                                      {"_id": 0, "markdown": 0})
    if not doc:
        doc = {"id": new_id(), "user_id": user["id"], "course_id": course["id"], "title": title, "kind": "scan",
               "status": "ready", "created_at": now(), "updated_at": now()}
        await db.documents.insert_one(dict(doc))
    return {"course": course, "document": clean(doc)}


# ---------------- Scanner (NAPS2 "command after scan") ----------------
class ScannerIn(BaseModel):
    course_id: str


async def _scanner_info(user: dict) -> dict:
    u = await db.users.find_one({"id": user["id"]}, {"_id": 0, "scan_key": 1, "scan_course_id": 1})
    if not u.get("scan_key"):
        u["scan_key"] = secrets.token_urlsafe(24)
        await db.users.update_one({"id": user["id"]}, {"$set": {"scan_key": u["scan_key"]}})
    course = await db.courses.find_one({"id": u.get("scan_course_id"), "user_id": user["id"]}, {"_id": 0}) \
        if u.get("scan_course_id") else None
    return {"key": u["scan_key"], "course_id": course["id"] if course else None,
            "course_name": course["name"] if course else "Inkorg"}


@api.get("/scanner")
async def get_scanner(user: dict = Depends(current_user)):
    return await _scanner_info(user)


@api.put("/scanner")
async def put_scanner(body: ScannerIn, user: dict = Depends(current_user)):
    await own("courses", body.course_id, user)
    await db.users.update_one({"id": user["id"]}, {"$set": {"scan_course_id": body.course_id}})
    return await _scanner_info(user)


@api.post("/scanner/key")
async def new_scanner_key(user: dict = Depends(current_user)):
    await db.users.update_one({"id": user["id"]}, {"$set": {"scan_key": secrets.token_urlsafe(24)}})
    return await _scanner_info(user)


SCAN_SCRIPT = r"""@echo off
rem CopyThat - skanna med NAPS2 och skicka till CopyThat.
rem  * Dubbelklicka: skannar med NAPS2 (standardprofilen) och skickar resultatet.
rem  * Dra filer (PDF/bilder) och slapp dem pa skriptet: skickar filerna.
rem  * I NAPS2 kan du lagga in skriptet som kommando, t.ex.  copythat-skanna.cmd "fil.pdf"
setlocal EnableDelayedExpansion
chcp 65001 >nul
set "KEY=__KEY__"
set "URL=__URL__"
rem Valfritt: en NAPS2-profil, t.ex.  set "NAPS2_ARGS=--profile CopyThat"
set "NAPS2_ARGS="

if not "%~1"=="" (
  for %%F in (%*) do call :send "%%~F"
  goto :end
)
set "NAPS2=%ProgramFiles%\NAPS2\NAPS2.Console.exe"
if not exist "!NAPS2!" set "NAPS2=%ProgramFiles(x86)%\NAPS2\NAPS2.Console.exe"
if not exist "!NAPS2!" (
  echo Hittar inte NAPS2.Console.exe. Installera NAPS2 fran https://www.naps2.com
  pause
  exit /b 1
)
set "OUT=%TEMP%\copythat_%RANDOM%%RANDOM%.pdf"
echo Skannar med NAPS2...
"!NAPS2!" -o "!OUT!" !NAPS2_ARGS!
if not exist "!OUT!" (
  echo Ingen skanning gjordes.
  pause
  exit /b 1
)
call :send "!OUT!"
del "!OUT!" >nul 2>&1
goto :end

:send
echo Skickar %~nx1 till CopyThat...
curl.exe -sS --fail-with-body -H "X-Scan-Key: %KEY%" -F "file=@%~1" "%URL%"
if errorlevel 1 (
  echo.
  echo Det gick inte att skicka %~nx1
  pause
) else (
  echo.
  echo Klart! Skanningen syns snart i CopyThat.
)
exit /b

:end
timeout /t 4 >nul
"""


async def _script_bytes(base: str, user: dict) -> bytes:
    if not re.match(r"^https?://[\w.\-:]+$", base):
        raise HTTPException(400, "Ogiltig adress")
    info = await _scanner_info(user)
    body = SCAN_SCRIPT.replace("__KEY__", info["key"]).replace("__URL__", f"{base}/api/scanner/upload")
    return body.replace("\n", "\r\n").encode("utf-8")


@api.get("/scanner/script")
async def scanner_script(base: str, user: dict = Depends(current_user)):
    """Personal Windows script (key + upload URL embedded). `base` = the app's backend URL."""
    return Response(await _script_bytes(base, user), media_type="application/octet-stream",
                    headers={"Content-Disposition": 'attachment; filename="copythat-skanna.cmd"'})


@api.post("/scanner/script/email")
async def email_scanner_script(base: str, user: dict = Depends(current_user)):
    """Mail a download link for the script (CommHub email has no attachments) — handy from the phone."""
    data = await _script_bytes(base, user)
    u = await db.users.find_one({"id": user["id"]}, {"_id": 0, "scan_script_file_id": 1})
    stored = await commhub_upload(data, "copythat-skanna.cmd", "application/octet-stream", "documents")
    await commhub_delete(u.get("scan_script_file_id"))
    await db.users.update_one({"id": user["id"]}, {"$set": {"scan_script_file_id": stored["id"]}})
    url = stored["url"]
    html = (
        '<div style="font-family:Arial,sans-serif;color:#1F2328;padding:16px">'
        '<p style="font-size:16px">Här är ditt CopyThat-skript för NAPS2.</p>'
        '<p style="font-size:14px">Öppna mejlet på din Windows-dator, ladda ner filen och lägg den t.ex. på skrivbordet. '
        'Dubbelklicka på den för att skanna och skicka till CopyThat.</p>'
        f'<p><a href="{url}" style="display:inline-block;background:#2F6FEB;color:#fff;padding:12px 20px;border-radius:8px;'
        'text-decoration:none;font-weight:bold">Ladda ner copythat-skanna.cmd</a></p>'
        '<p style="font-size:12px;color:#6B6F76">Skriptet innehåller din personliga skannernyckel – dela det inte. '
        'Byter du nyckel i appen slutar det här skriptet att fungera.</p></div>'
    )
    try:
        await commhub_send_email(user["email"], "Ditt CopyThat-skript för NAPS2", html,
                                 f"Ladda ner ditt CopyThat-skript för NAPS2 på Windows-datorn: {url}")
    except RuntimeError:
        raise HTTPException(503, "Mejlet kunde inte skickas just nu. Försök igen om en stund.")
    return {"ok": True, "email": user["email"]}


@api.post("/scanner/upload")
async def scanner_upload(file: UploadFile = File(...), x_scan_key: str = Header("")):
    """Called by the NAPS2 script: creates a new document in the chosen folder and starts AI reading."""
    user = await db.users.find_one({"scan_key": x_scan_key}, {"_id": 0}) if x_scan_key else None
    if not user:
        raise HTTPException(401, "Ogiltig skannernyckel")
    data = await file.read()
    if not data:
        raise HTTPException(400, "Filen var tom")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Filen är för stor (max 500 MB)")
    info = await _scanner_info(user)
    course_id = info["course_id"] or (await inbox(user))["course"]["id"]
    from datetime import datetime
    from zoneinfo import ZoneInfo
    title = f"Skanning {datetime.now(ZoneInfo('Europe/Stockholm')):%Y-%m-%d %H:%M}"
    doc = {"id": new_id(), "user_id": user["id"], "course_id": course_id, "title": title, "kind": "scan",
           "status": "ready", "created_at": now(), "updated_at": now()}
    await db.documents.insert_one(dict(doc))
    try:
        n = await pipeline.ingest(doc, user, data, file.filename or "skanning.pdf")
    except ValueError as e:
        await delete_document_data(doc["id"])
        raise HTTPException(422, str(e))
    except RuntimeError as e:
        await delete_document_data(doc["id"])
        raise HTTPException(502, str(e))
    return {"ok": True, "document_id": doc["id"], "title": title, "pages": n}


# ---------------- Chunked uploads ----------------
class UploadInit(BaseModel):
    document_id: str
    filename: str
    size: int = 0


@api.post("/uploads/init")
async def upload_init(body: UploadInit, user: dict = Depends(current_user)):
    await own("documents", body.document_id, user)
    if body.size > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Filen är för stor (max 500 MB)")
    uid = new_id()
    (UPLOADS / uid).mkdir()
    await db.uploads.insert_one({"id": uid, "user_id": user["id"], "document_id": body.document_id,
                                 "filename": body.filename[:200], "created_at": now()})
    return {"upload_id": uid, "chunk_size": 4 * 1024 * 1024}


@api.post("/uploads/{upload_id}/chunk")
async def upload_chunk(upload_id: str, index: int = Form(...), file: UploadFile = File(...),
                       user: dict = Depends(current_user)):
    await own("uploads", upload_id, user)
    (UPLOADS / upload_id / f"{index:06d}").write_bytes(await file.read())
    return {"ok": True}


@api.post("/uploads/{upload_id}/complete")
async def upload_complete(upload_id: str, user: dict = Depends(current_user)):
    up = await own("uploads", upload_id, user)
    folder = UPLOADS / upload_id
    data = b"".join(p.read_bytes() for p in sorted(folder.iterdir()))
    shutil.rmtree(folder, ignore_errors=True)
    await db.uploads.delete_one({"id": upload_id})
    if not data:
        raise HTTPException(400, "Filen var tom")
    doc = await own("documents", up["document_id"], user)
    try:
        n = await pipeline.ingest(doc, user, data, up["filename"])
    except ValueError as e:
        raise HTTPException(422, str(e))
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    return {"pages_created": n}


# ---------------- Pages ----------------
class PagePatch(BaseModel):
    markdown: str | None = None


class FigurePatch(BaseModel):
    box_2d: list[float] | None = None
    deleted: bool | None = None
    caption: str | None = None


@api.patch("/pages/{page_id}")
async def patch_page(page_id: str, body: PagePatch, user: dict = Depends(current_user)):
    await own("pages", page_id, user)
    if body.markdown is not None:
        await db.pages.update_one({"id": page_id}, {"$set": {"markdown": body.markdown, "edited": True,
                                                             "updated_at": now()}})
    return await own("pages", page_id, user)


@api.delete("/pages/{page_id}")
async def delete_page(page_id: str, user: dict = Depends(current_user)):
    p = await own("pages", page_id, user)
    await db.pages.delete_one({"id": page_id})
    await commhub_delete(p.get("image_file_id"))
    return {"ok": True}


@api.post("/pages/{page_id}/rescan")
async def rescan_page(page_id: str, user: dict = Depends(current_user)):
    p = await own("pages", page_id, user)
    if p["status"] in ("queued", "processing"):
        raise HTTPException(409, "Sidan läses redan")
    await db.pages.update_one({"id": page_id}, {"$set": {"status": "queued", "error": None}})
    pipeline.enqueue(page_id, rescan=p["status"] == "done")
    return {"ok": True}


@api.patch("/pages/{page_id}/figures/{fig_id}")
async def patch_figure(page_id: str, fig_id: str, body: FigurePatch, user: dict = Depends(current_user)):
    p = await own("pages", page_id, user)
    figs = p.get("figures", [])
    f = next((x for x in figs if x["id"] == fig_id), None)
    if not f:
        raise HTTPException(404, "Bilden hittades inte")
    if body.deleted is not None:
        f["deleted"] = body.deleted
    if body.caption is not None:
        f["caption"] = body.caption[:300]
    if body.box_2d and len(body.box_2d) == 4:
        stored = await pipeline.crop_and_store(await pipeline.page_image(p), page_id, body.box_2d)
        if not stored:
            raise HTTPException(422, "Utklippet är för litet")
        await commhub_delete(f.get("file_id"))
        f.update(box_2d=body.box_2d, url=stored["url"], file_id=stored["file_id"])
    await db.pages.update_one({"id": page_id}, {"$set": {"figures": figs, "updated_at": now()}})
    return await own("pages", page_id, user)


class FigureNew(BaseModel):
    box_2d: list[float]
    caption: str = ""


@api.post("/pages/{page_id}/figures")
async def add_figure(page_id: str, body: FigureNew, user: dict = Depends(current_user)):
    p = await own("pages", page_id, user)
    stored = await pipeline.crop_and_store(await pipeline.page_image(p), page_id, body.box_2d)
    if not stored:
        raise HTTPException(422, "Utklippet är för litet")
    n = max([f["n"] for f in p.get("figures", [])] + [0]) + 1
    fig = {"n": n, "box_2d": body.box_2d, "caption": body.caption, "deleted": False, **stored}
    md = (p.get("markdown") or "").rstrip() + f"\n\n[[FIGURE:{n}]]\n"
    await db.pages.update_one({"id": page_id}, {"$push": {"figures": fig}, "$set": {"markdown": md}})
    return await own("pages", page_id, user)


# ---------------- Free instructions ----------------
class ProcessIn(BaseModel):
    instruction: str = Field(min_length=3, max_length=4000)
    document_ids: list[str] = []
    page_ids: list[str] = []
    title: str | None = None
    course_id: str | None = None


async def run_process(new_doc_id: str, material: str, figmap: dict, instruction: str, captions: dict) -> None:
    try:
        out = strip_html(await run_instruction(material, instruction, await pipeline.settings_doc()))
        used = {fid: url for fid, url in figmap.items() if f"fig:{fid}" in out}
        await db.documents.update_one({"id": new_doc_id}, {"$set": {
            "markdown": out, "figures": used, "source_figures": figmap, "figure_captions": captions,
            "status": "ready", "updated_at": now()}})
    except Exception as e:
        msg = str(e) if isinstance(e, AIError) else f"Oväntat fel: {e}"
        log.warning("process failed: %s", msg)
        await db.documents.update_one({"id": new_doc_id}, {"$set": {"status": "error", "error": msg[:300]}})


@api.post("/process")
async def process(body: ProcessIn, bg: BackgroundTasks, user: dict = Depends(current_user)):
    parts, figmap, titles, course_id = [], {}, [], body.course_id
    from export import page_markdown_with_refs
    if body.page_ids:
        pages = await db.pages.find({"id": {"$in": body.page_ids}, "user_id": user["id"], "status": "done"},
                                    {"_id": 0}).sort("order", 1).to_list(2000)
        for p in pages:
            parts.append(page_markdown_with_refs(p))
            figmap.update({f["id"]: f["url"] for f in p.get("figures", []) if not f.get("deleted")})
        if pages and not course_id:
            src = await own("documents", pages[0]["document_id"], user)
            course_id, titles = src["course_id"], [src["title"]]
    for did in body.document_ids:
        d = await own("documents", did, user)
        md, fm = await document_markdown(d)
        parts.append(f"# {d['title']}\n\n{md}" if len(body.document_ids) > 1 else md)
        figmap.update(fm)
        titles.append(d["title"])
        course_id = course_id or d["course_id"]
    material = "\n\n".join(x for x in parts if x.strip())
    captions = {fid: c for c, fid in REF_CAPTIONS.findall(material)}
    if not material.strip():
        raise HTTPException(422, "Det valda materialet innehåller ingen läst text än")
    await own("courses", course_id, user)
    title = (body.title or "").strip() or f"{body.instruction.strip()[:50]} – {', '.join(titles)[:60]}"
    d = {"id": new_id(), "user_id": user["id"], "course_id": course_id, "title": title, "kind": "generated",
         "status": "processing", "instruction": body.instruction, "source_document_ids": body.document_ids,
         "source_page_ids": body.page_ids, "markdown": "", "figures": {}, "created_at": now(),
         "updated_at": now()}
    await db.documents.insert_one(dict(d))
    bg.add_task(run_process, d["id"], material, figmap, body.instruction, captions)
    return clean(d)


# ---------------- Templates ----------------
class TemplateIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    instruction: str = Field(min_length=3, max_length=4000)


DEFAULT_TEMPLATES = [
    ("Sammanfattning", "Gör en tydlig sammanfattning med rubriker och de viktigaste begreppen i fetstil."),
    ("Instuderingsfrågor", "Skriv 10 instuderingsfrågor med utförliga svar baserat på materialet."),
    ("Begreppslista", "Gör en alfabetisk begreppslista med korta förklaringar av alla viktiga begrepp."),
    ("Förenkla", "Skriv om texten så att den blir lättare att förstå, på gymnasienivå, utan att tappa fakta."),
]


@api.get("/templates")
async def list_templates(user: dict = Depends(current_user)):
    if not await db.templates.find_one({"user_id": user["id"]}):
        for name, ins in DEFAULT_TEMPLATES:
            await db.templates.insert_one({"id": new_id(), "user_id": user["id"], "name": name,
                                           "instruction": ins, "created_at": now()})
    return await db.templates.find({"user_id": user["id"]}, {"_id": 0}).sort("created_at", 1).to_list(200)


@api.post("/templates")
async def create_template(body: TemplateIn, user: dict = Depends(current_user)):
    t = {"id": new_id(), "user_id": user["id"], "name": body.name.strip(), "instruction": body.instruction.strip(),
         "created_at": now()}
    await db.templates.insert_one(dict(t))
    return t


@api.delete("/templates/{tid}")
async def delete_template(tid: str, user: dict = Depends(current_user)):
    await db.templates.delete_one({"id": tid, "user_id": user["id"]})
    return {"ok": True}


# ---------------- Search ----------------
@api.get("/search")
async def search(q: str, user: dict = Depends(current_user)):
    q = q.strip()
    if len(q) < 2:
        return []
    rx = {"$regex": re.escape(q), "$options": "i"}
    docs = {d["id"]: d async for d in db.documents.find(
        {"user_id": user["id"], "deleting": {"$ne": True}}, {"_id": 0, "id": 1, "title": 1, "course_id": 1,
                                                            "kind": 1, "markdown": 1})}
    hits = []
    for d in docs.values():
        text = d.get("markdown") or ""
        if re.search(re.escape(q), d["title"], re.I) or re.search(re.escape(q), text, re.I):
            hits.append({"document_id": d["id"], "title": d["title"], "course_id": d["course_id"],
                         "snippet": _snippet(text, q) or d["title"], "page_id": None})
    async for p in db.pages.find({"user_id": user["id"], "markdown": rx},
                                 {"_id": 0, "id": 1, "document_id": 1, "markdown": 1, "order": 1}).limit(50):
        d = docs.get(p["document_id"])
        if d:
            hits.append({"document_id": d["id"], "title": d["title"], "course_id": d["course_id"],
                         "snippet": _snippet(p["markdown"], q), "page_id": p["id"], "page_index": p["order"] + 1})
    return hits[:60]


def _snippet(text: str, q: str) -> str:
    m = re.search(re.escape(q), text or "", re.I)
    if not m:
        return ""
    s = max(0, m.start() - 60)
    return ("…" if s else "") + text[s:m.end() + 80].replace("\n", " ") + "…"


# ---------------- Export ----------------
@api.get("/documents/{doc_id}/export")
async def export(doc_id: str, format: str = "docx", user: dict = Depends(current_user)):
    d = await own("documents", doc_id, user)
    try:
        files = await build_files(d, html=format == "html", pdf=format in ("pdf", "zip"))
    except Exception as e:
        log.exception("export failed")
        raise HTTPException(500, f"Exporten misslyckades: {e}")
    base = safe_name(d["title"])
    from urllib.parse import quote
    if format == "zip":
        data, mime, ext = make_zip(files, base), "application/zip", "zip"
    elif format == "html":
        return Response(files["html"], media_type="text/html; charset=utf-8")
    elif format == "pdf":
        data, mime, ext = files["pdf"], "application/pdf", "pdf"
    elif format == "txt":
        data, mime, ext = files["txt"].encode(), "text/plain; charset=utf-8", "txt"
    else:
        data, mime, ext = files["docx"], "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"
    return Response(data, media_type=mime, headers={
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(base)}.{ext}"})


@api.post("/documents/{doc_id}/email")
async def email_zip(doc_id: str, user: dict = Depends(current_user)):
    """Upload the ZIP to CommHub storage and email a download link to the logged-in user."""
    d = await own("documents", doc_id, user)
    try:
        files = await build_files(d, pdf=True)
        base = safe_name(d["title"])
        stored = await commhub_upload(make_zip(files, base), f"{base}.zip", "application/zip", "documents")
    except Exception as e:
        log.exception("email zip failed")
        raise HTTPException(500, f"ZIP-filen kunde inte skapas: {e}")
    await commhub_delete(d.get("email_zip_id"))
    await db.documents.update_one({"id": doc_id}, {"$set": {"email_zip_id": stored["id"]}})
    from html import escape
    t, url, n = escape(d["title"]), stored["url"], len(files["images"])
    html = (
        '<table role="presentation" width="100%"><tr><td style="padding:24px;font-family:Arial,sans-serif;color:#1F2328">'
        f'<p style="font-size:16px">Här är ditt inskannade dokument <b>{t}</b> från CopyThat.</p>'
        f'<p style="font-size:14px;color:#6B6F76">ZIP-filen innehåller Word-dokumentet, en PDF, texten (.txt) och {n} bilder.</p>'
        f'<p><a href="{url}" style="display:inline-block;background:#2F6FEB;color:#fff;padding:12px 20px;'
        'border-radius:8px;text-decoration:none;font-weight:bold">Ladda ner ZIP</a></p>'
        f'<p style="font-size:12px;color:#6B6F76">Fungerar inte knappen? Kopiera länken: {url}</p></td></tr></table>'
    )
    try:
        await commhub_send_email(user["email"], f"CopyThat: {d['title']}", html,
                                 f"Ditt dokument {d['title']} från CopyThat. Ladda ner ZIP: {url}")
    except RuntimeError:
        raise HTTPException(503, "Mejlet kunde inte skickas just nu. Försök igen om en stund.")
    return {"ok": True, "email": user["email"]}


@api.get("/documents/{doc_id}/markdown")
async def get_markdown(doc_id: str, user: dict = Depends(current_user)):
    d = await own("documents", doc_id, user)
    md, figmap = await document_markdown(d)
    return {"markdown": md, "figures": figmap}


@api.get("/health")
async def health():
    return {"ok": True}


app.include_router(api)
app.add_middleware(CORSMiddleware, allow_credentials=False, allow_origins=["*"], allow_methods=["*"],
                   allow_headers=["*"])


@app.on_event("startup")
async def startup():
    await db.users.create_index("email", unique=True)
    await db.users.create_index("scan_key", sparse=True)
    await db.pages.create_index([("document_id", 1), ("order", 1)])
    for e, role in ((OWNER_EMAIL, "owner"), (TEST_LOGIN_EMAIL, "member")):
        if e and not await db.users.find_one({"email": e}):
            await db.users.insert_one({"id": new_id(), "email": e, "role": role, "created_at": now()})
    await db.users.update_one({"email": OWNER_EMAIL}, {"$set": {"role": "owner"}})
    await pipeline.resume_pending()
