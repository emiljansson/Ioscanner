"""Ingest uploads (images + PDFs), run page OCR in the background, crop figures."""
import io
import re
import asyncio
from pathlib import Path

import pymupdf
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener

from core import db, new_id, now, commhub_upload, fetch_bytes, log
from ai import read_page, detect_figures, AIError

register_heif_opener()

MAX_PAGES = 200
CACHE = Path("/tmp/copythat_cache")
CACHE.mkdir(parents=True, exist_ok=True)
_sem = asyncio.Semaphore(3)


def _jpeg(img: Image.Image, max_side: int, quality: int = 88) -> bytes:
    img = img.copy()
    img.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality)
    return buf.getvalue()


def split_to_page_images(data: bytes, filename: str) -> list[bytes]:
    """Return full-resolution JPEG bytes per page."""
    if data[:5] == b"%PDF-" or filename.lower().endswith(".pdf"):
        doc = pymupdf.open(stream=data, filetype="pdf")
        if doc.page_count > MAX_PAGES:
            raise ValueError(f"PDF:en har {doc.page_count} sidor – max {MAX_PAGES} per uppladdning")
        out = []
        for page in doc:
            pix = page.get_pixmap(dpi=250)
            img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
            out.append(_jpeg(img, 3600, 90))
        return out
    try:
        img = Image.open(io.BytesIO(data))
    except Exception:
        raise ValueError("Filformatet stöds inte – använd JPG, PNG, HEIC, WebP, TIFF eller PDF")
    frames = []
    for i in range(getattr(img, "n_frames", 1)):  # multi-page TIFF
        img.seek(i)
        frames.append(_jpeg(ImageOps.exif_transpose(img).convert("RGB"), 3600, 90))
        if len(frames) >= MAX_PAGES:
            break
    return frames


async def page_image(page: dict) -> bytes:
    path = CACHE / f"{page['id']}.jpg"
    if path.exists():
        return path.read_bytes()
    data = await fetch_bytes(page["image_url"])
    path.write_bytes(data)
    return data


async def ingest(document: dict, user: dict, data: bytes, filename: str) -> int:
    images = await asyncio.to_thread(split_to_page_images, data, filename)
    last = await db.pages.find_one({"document_id": document["id"]}, sort=[("order", -1)])
    order = (last or {}).get("order", -1) + 1
    for i, jpg in enumerate(images):
        pid = new_id()
        (CACHE / f"{pid}.jpg").write_bytes(jpg)
        stored = await commhub_upload(jpg, f"{pid}.jpg", "image/jpeg", "images")
        with Image.open(io.BytesIO(jpg)) as im:
            w, h = im.size
        await db.pages.insert_one({
            "id": pid, "user_id": user["id"], "document_id": document["id"], "order": order + i,
            "source_name": filename, "source_index": i + 1, "status": "queued", "error": None,
            "image_url": stored["url"], "image_file_id": stored["id"], "width": w, "height": h,
            "markdown": "", "confidence": None, "page_number": None, "figures": [], "attempts": 0,
            "created_at": now(), "updated_at": now(),
        })
        enqueue(pid)
    await db.documents.update_one({"id": document["id"]}, {"$set": {"updated_at": now()}})
    return len(images)


def _crop_box(w: int, h: int, box: list[float]) -> tuple[int, int, int, int] | None:
    ymin, xmin, ymax, xmax = [max(0.0, min(1000.0, v)) for v in box]
    if ymax <= ymin or xmax <= xmin:
        return None
    pad = 8  # ~0.8% padding
    x0, y0 = int(max(0, xmin - pad) / 1000 * w), int(max(0, ymin - pad) / 1000 * h)
    x1, y1 = int(min(1000, xmax + pad) / 1000 * w), int(min(1000, ymax + pad) / 1000 * h)
    if (x1 - x0) * (y1 - y0) < 0.005 * w * h:
        return None
    return x0, y0, x1, y1


async def crop_and_store(full: bytes, page_id: str, box: list[float]) -> dict | None:
    def _do():
        with Image.open(io.BytesIO(full)) as im:
            rect = _crop_box(im.width, im.height, box)
            if not rect:
                return None
            buf = io.BytesIO()
            im.convert("RGB").crop(rect).save(buf, "JPEG", quality=92)
            return buf.getvalue()
    data = await asyncio.to_thread(_do)
    if not data:
        return None
    fid = new_id()
    stored = await commhub_upload(data, f"{page_id}_{fid}.jpg", "image/jpeg", "images")
    return {"id": fid, "url": stored["url"], "file_id": stored["id"]}


async def settings_doc() -> dict:
    return await db.settings.find_one({"id": "global"}, {"_id": 0}) or {}


async def process_page(page_id: str, rescan: bool = False) -> None:
    async with _sem:
        page = await db.pages.find_one({"id": page_id}, {"_id": 0})
        if not page:
            return
        await db.pages.update_one({"id": page_id}, {"$set": {"status": "processing", "error": None,
                                                             "started_at": now()}})
        try:
            full = await page_image(page)
            with Image.open(io.BytesIO(full)) as im:
                ai_jpg = _jpeg(im.convert("RGB"), 2000, 85)
            attempts = page.get("attempts", 0) + 1
            settings = await settings_doc()
            res = await read_page(ai_jpg, settings,
                                  prev_markdown=page["markdown"] if rescan and page.get("markdown") else None,
                                  attempts=attempts, prev_conf=page.get("confidence") or 0)
            found = res.pop("figures")
            md = res.pop("markdown")
            if not found:
                # The reading pass found no images – run a dedicated image-finding pass.
                try:
                    found = await detect_figures(ai_jpg, settings)
                    if found:
                        md = md.rstrip() + "\n\n" + "\n\n".join(f"[[FIGURE:{f['n']}]]" for f in found)
                except Exception as e:
                    log.warning("figure detection failed for %s: %s", page_id, e)
            figures = []
            for f in found:
                stored = await crop_and_store(full, page_id, f["box_2d"])
                if stored:
                    figures.append({**f, **stored, "deleted": False})
            kept = {f["n"] for f in figures}
            md = re.sub(r"\[\[FIGURE:(\d+)\]\]", lambda m: m.group(0) if int(m.group(1)) in kept else "", md)
            await db.pages.update_one({"id": page_id}, {"$set": {
                "status": "done", "markdown": md, "figures": figures, "attempts": attempts,
                "confidence": res["confidence"], "page_number": res["page_number"], "ai": res,
                "updated_at": now(),
            }})
        except Exception as e:
            if isinstance(e, AIError):
                msg = str(e)
            else:
                log.exception("page %s failed", page_id)
                msg = f"Oväntat fel: {e}"
            await db.pages.update_one({"id": page_id}, {"$set": {"status": "error", "error": msg[:300],
                                                                 "updated_at": now()}})
        await maybe_autosort(page["document_id"])


async def maybe_autosort(document_id: str) -> None:
    pending = await db.pages.count_documents({"document_id": document_id, "status": {"$in": ["queued", "processing"]}})
    if pending == 0:
        await sort_pages(document_id)


async def sort_pages(document_id: str) -> None:
    """Sort by detected page number; unnumbered pages keep their relative upload position."""
    pages = await db.pages.find({"document_id": document_id}, {"_id": 0, "id": 1, "order": 1,
                                                               "page_number": 1}).sort("order", 1).to_list(2000)
    numbered = sorted([p for p in pages if p.get("page_number") is not None], key=lambda p: p["page_number"])
    it = iter(numbered)
    result = [p if p.get("page_number") is None else next(it) for p in pages]
    for i, p in enumerate(result):
        if p["order"] != i:
            await db.pages.update_one({"id": p["id"]}, {"$set": {"order": i}})


def enqueue(page_id: str, rescan: bool = False) -> None:
    asyncio.get_event_loop().create_task(process_page(page_id, rescan))


async def resume_pending() -> None:
    async for p in db.pages.find({"status": {"$in": ["queued", "processing"]}}, {"id": 1}):
        enqueue(p["id"])
