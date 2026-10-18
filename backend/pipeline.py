"""Ingest uploads (images + PDFs), run page OCR in the background, crop figures."""
import io
import re
import asyncio
from pathlib import Path

import pymupdf
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener

from core import db, new_id, now, commhub_upload, fetch_bytes, log
from ai import read_page, detect_figures, merge_figures, AIError

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
    if (x1 - x0) * (y1 - y0) < 0.0005 * w * h:  # keep small pictograms (bildstöd)
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


def grow_box(im: Image.Image, box: list[float]) -> list[float]:
    """Expand a 0-1000 box ONLY across a clearly coloured panel the box sits on (e.g. a logo on a red
    panel -> the whole red panel). Neutral colours (white/cream/grey/black) never grow, so photos of
    objects in a room are not swallowed. Final box is capped at 70 % of the page per axis."""
    W = 500
    scale = W / im.width
    small = im.convert("RGB").resize((W, max(1, int(im.height * scale))))
    w, h = small.size
    px = small.load()
    y0, x0 = int(box[0] / 1000 * h), int(box[1] / 1000 * w)
    y1, x1 = min(h - 1, int(box[2] / 1000 * h)), min(w - 1, int(box[3] / 1000 * w))
    if y1 <= y0 or x1 <= x0:
        return box
    edge = [px[x, y] for x in range(x0, x1 + 1) for y in (y0, y1)] + [px[x, y] for y in range(y0, y1 + 1) for x in (x0, x1)]
    panel = tuple(sorted(c[i] for c in edge)[len(edge) // 2] for i in range(3))
    if max(panel) - min(panel) < 60:  # neutral colour -> no panel to grow into
        return box

    def match(x, y):
        r, g, b = px[x, y]
        return abs(r - panel[0]) + abs(g - panel[1]) + abs(b - panel[2]) < 90

    def share(xs, ys):
        n = len(xs) * len(ys)
        return sum(1 for x in xs for y in ys if match(x, y)) / n if n else 0

    limit = 0.5
    for _ in range(max(w, h)):
        grew = False
        if y0 > 0 and (y1 - y0) < 0.7 * h and share(range(x0, x1 + 1), [y0 - 1]) >= limit:
            y0 -= 1; grew = True  # noqa: E702
        if y1 < h - 1 and (y1 - y0) < 0.7 * h and share(range(x0, x1 + 1), [y1 + 1]) >= limit:
            y1 += 1; grew = True  # noqa: E702
        if x0 > 0 and (x1 - x0) < 0.7 * w and share([x0 - 1], range(y0, y1 + 1)) >= limit:
            x0 -= 1; grew = True  # noqa: E702
        if x1 < w - 1 and (x1 - x0) < 0.7 * w and share([x1 + 1], range(y0, y1 + 1)) >= limit:
            x1 += 1; grew = True  # noqa: E702
        if not grew:
            break
    return [y0 / h * 1000, x0 / w * 1000, (y1 + 1) / h * 1000, (x1 + 1) / w * 1000]


def drop_whole_page(figs: list[dict]) -> list[dict]:
    """A box covering most of the page is the page/photo itself, not a figure on it."""
    return [f for f in figs if (f["box_2d"][2] - f["box_2d"][0]) * (f["box_2d"][3] - f["box_2d"][1]) < 0.6 * 1_000_000]


def dedupe_boxes(figs: list[dict]) -> list[dict]:
    """Drop boxes that lie (mostly) inside a bigger one – parts of the same image."""
    def area(b):
        return max(0, b[2] - b[0]) * max(0, b[3] - b[1])

    def inter(a, b):
        return area([max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])])
    figs = sorted(figs, key=lambda f: -area(f["box_2d"]))
    kept: list[dict] = []
    for f in figs:
        a = area(f["box_2d"]) or 1
        if all(inter(f["box_2d"], k["box_2d"]) / a < 0.6 for k in kept):
            kept.append(f)
    return kept


async def refine_figures(full: bytes, figs: list[dict]) -> list[dict]:
    def _do():
        with Image.open(io.BytesIO(full)) as im:
            for f in figs:
                f["box_2d"] = grow_box(im, f["box_2d"])
        return dedupe_boxes(drop_whole_page(figs))
    return await asyncio.to_thread(_do)


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
            # Always run the dedicated object-cutting pass and merge in anything the reading pass missed.
            try:
                det = await detect_figures(ai_jpg, settings)
                md, found = merge_figures(md, found, det)
            except Exception as e:
                log.warning("figure detection failed for %s: %s", page_id, e)
            figures = []
            if found:
                found = await refine_figures(full, found)
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
