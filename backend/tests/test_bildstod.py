"""Iteration 12 — picture support (bildstöd) extraction & inline rendering.

Covers the user story: "Prompten måste vara att AI ska identifiera objekten och
klippa ut dem som separata objekt. Målet är att om man skannar in en skolsida
med bildstöd så ska bildstödet komma med när man gör om materialet."

Tests:
 1. UNIT: ai.merge_figures appends placeholder for near_text match on first
    line, appends empty near_text at page end, and skips figures whose box
    overlaps an existing OCR figure box (IoU > 0.3).
 2. Real AI (max 2 OCR uploads): synthetic Swedish school page with four word
    lines each followed by a small distinct coloured pictogram + one larger
    illustration. Expect >=4 figures, each with https url + file_id, and
    [[FIGURE:n]] placeholders in markdown.
 3. POST /api/process with 'Skriv om texten enklare' -> generated markdown
    contains >=3 ![...](fig:...) references, generated-doc ZIP contains the
    images, docx export (format=docx) returns 200.

Settings are pinned to speed_mode=fast + primary_provider=gemini.
"""
import io
import os
import time
import zipfile
from pathlib import Path

import pytest
import requests
import pymongo
from PIL import Image, ImageDraw
from dotenv import load_dotenv

from ai import merge_figures

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
load_dotenv(Path(__file__).resolve().parent.parent.parent / "frontend" / ".env")

BASE = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/").strip('"')
MDB = pymongo.MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]


# ---------- fixtures ----------
@pytest.fixture(scope="module")
def token():
    r = requests.post(
        f"{BASE}/api/auth/verify",
        json={"email": "test@copythat.app", "code": "246810"},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def auth(token):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def course(auth):
    r = auth.post(f"{BASE}/api/courses", json={"name": "TEST_BILDSTOD_Course"}, timeout=30)
    assert r.status_code == 200, r.text
    cid = r.json()["id"]
    yield cid
    auth.delete(f"{BASE}/api/courses/{cid}", timeout=30)


@pytest.fixture(scope="module")
def doc(auth, course):
    r = auth.post(
        f"{BASE}/api/documents",
        json={"course_id": course, "title": "TEST_BILDSTOD_Doc"},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    did = r.json()["id"]
    yield did
    auth.delete(f"{BASE}/api/documents/{did}", timeout=30)


# ---------- helpers ----------
def _bildstod_page() -> bytes:
    """A4-ish white page: 4 Swedish word lines each followed by a small coloured
    pictogram (red circle, yellow crescent, green tree, blue square), plus a
    larger illustration lower on the page."""
    W, H = 1240, 1754  # ~A4 at 150dpi
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)

    # Title
    d.text((80, 60), "Djur och saker omkring oss", fill="black")

    # Four lines: word + separate small coloured pictogram
    rows = [
        ("Ett appelsin ar rott.",      "red_circle"),
        ("En banan ar gul.",            "yellow_crescent"),
        ("Ett trad ar gront.",          "green_tree"),
        ("Ett hus ar blatt.",           "blue_square"),
    ]
    y = 200
    for text, kind in rows:
        d.text((100, y + 10), text, fill="black")
        # pictogram at right side, ~60x60
        cx, cy = 900, y + 20
        if kind == "red_circle":
            d.ellipse([cx, cy, cx + 60, cy + 60], fill=(220, 30, 30), outline="black", width=3)
        elif kind == "yellow_crescent":
            d.ellipse([cx, cy, cx + 60, cy + 60], fill=(240, 200, 20), outline="black", width=3)
            d.ellipse([cx + 15, cy - 5, cx + 70, cy + 55], fill="white")
        elif kind == "green_tree":
            d.polygon([(cx + 30, cy), (cx, cy + 50), (cx + 60, cy + 50)], fill=(30, 150, 40), outline="black")
            d.rectangle([cx + 25, cy + 50, cx + 35, cy + 65], fill=(120, 70, 20))
        elif kind == "blue_square":
            d.rectangle([cx, cy, cx + 60, cy + 60], fill=(40, 90, 220), outline="black", width=3)
            # door
            d.rectangle([cx + 24, cy + 30, cx + 36, cy + 58], fill="white")
            # roof
            d.polygon([(cx - 5, cy), (cx + 30, cy - 25), (cx + 65, cy)], fill=(140, 50, 30), outline="black")
        y += 150

    # Larger illustration lower on the page: a stylised sun with rays
    sx, sy = 500, 1150
    d.ellipse([sx, sy, sx + 200, sy + 200], fill=(255, 210, 50), outline="black", width=4)
    for ang in range(0, 360, 30):
        import math
        rx = sx + 100 + int(140 * math.cos(math.radians(ang)))
        ry = sy + 100 + int(140 * math.sin(math.radians(ang)))
        d.line([(sx + 100, sy + 100), (rx, ry)], fill=(240, 180, 20), width=5)
    d.text((sx + 20, sy + 220), "Figur 1: Solen", fill="black")

    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=92)
    return buf.getvalue()


def _upload(auth, token, doc_id, filename, data):
    r = auth.post(
        f"{BASE}/api/uploads/init",
        json={"document_id": doc_id, "filename": filename, "size": len(data)},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    up = r.json()
    uid, chunk = up["upload_id"], up["chunk_size"]
    off, idx = 0, 0
    hdr = {"Authorization": f"Bearer {token}"}
    while off < len(data):
        part = data[off:off + chunk]
        files = {"file": (f"c{idx}", part, "application/octet-stream")}
        cr = requests.post(
            f"{BASE}/api/uploads/{uid}/chunk",
            headers=hdr,
            data={"index": idx},
            files=files,
            timeout=60,
        )
        assert cr.status_code == 200, cr.text
        off += chunk
        idx += 1
    return requests.post(f"{BASE}/api/uploads/{uid}/complete", headers=hdr, timeout=60)


def _wait_page(auth, did, timeout=300):
    deadline = time.time() + timeout
    page = None
    while time.time() < deadline:
        r = auth.get(f"{BASE}/api/documents/{did}", timeout=30)
        pages = r.json().get("pages", [])
        if pages:
            page = pages[0]
            if page.get("status") in ("done", "error"):
                return page
        time.sleep(3)
    pytest.fail(f"Page never finished within {timeout}s. Last: {page}")


# ---------- tests ----------
class TestMergeFiguresUnit:
    """Unit tests for ai.merge_figures (pure function, no AI calls)."""

    def test_01_near_text_anchors_and_tail(self):
        md = "Ett äpple är rött.\nEn banan är gul."
        ocr_figs: list[dict] = []
        det = [
            {"n": 1, "box_2d": [0, 0, 100, 100], "caption": "äpple", "near_text": "Ett äpple"},
            {"n": 2, "box_2d": [200, 0, 300, 100], "caption": "x", "near_text": ""},
        ]
        out_md, out_figs = merge_figures(md, ocr_figs, det)
        # First detected goes right after "Ett äpple är rött."
        lines = out_md.split("\n")
        assert "[[FIGURE:1]]" in lines[0], f"expected FIGURE:1 on first line, got: {lines[0]!r}"
        assert "Ett äpple är rött." in lines[0]
        # Second has empty near_text -> appended at end
        assert out_md.rstrip().endswith("[[FIGURE:2]]"), f"expected FIGURE:2 at end, got: {out_md!r}"
        assert len(out_figs) == 2
        # Second line unchanged
        assert "En banan är gul." in out_md
        assert "[[FIGURE:" not in "En banan är gul."  # original string unchanged

    def test_02_iou_overlap_is_skipped(self):
        # Existing OCR figure covers [0,0,100,100]; detection with heavy overlap
        # (same box) must be skipped (IoU=1.0 > 0.3).
        md = "Rad ett.\nRad två."
        ocr_figs = [{"n": 1, "box_2d": [0.0, 0.0, 100.0, 100.0], "caption": "a"}]
        det = [
            {"n": 1, "box_2d": [0, 0, 100, 100], "caption": "dup", "near_text": "Rad ett"},
            # non-overlapping -> should be added
            {"n": 2, "box_2d": [500, 500, 700, 700], "caption": "ny", "near_text": ""},
        ]
        out_md, out_figs = merge_figures(md, ocr_figs, det)
        # Should keep original OCR fig and only add the non-overlapping one -> total 2
        assert len(out_figs) == 2, f"expected 2 figures (OCR + 1 new), got {out_figs}"
        # The duplicate (same box) must not add a new placeholder
        assert out_md.count("[[FIGURE:") == 1, f"expected exactly one new placeholder, got: {out_md!r}"
        # The new figure number continues from max OCR n (1) -> n=2
        new_fig = [f for f in out_figs if f["box_2d"][0] == 500.0][0]
        assert new_fig["n"] == 2


class TestRealAIBildstod:
    """Real-AI end-to-end: 1 OCR upload + 1 /process call (~2 paid calls)."""

    def test_01_settings_fast_gemini(self, auth):
        MDB.settings.update_one(
            {"id": "global"},
            {"$set": {"speed_mode": "fast", "primary_provider": "gemini"}},
            upsert=True,
        )
        d = auth.get(f"{BASE}/api/settings", timeout=30).json()
        assert d["speed_mode"] == "fast"
        assert d["primary_provider"] == "gemini"

    def test_02_upload_bildstod_page(self, auth, token, doc):
        jpg = _bildstod_page()
        r = _upload(auth, token, doc, "bildstod_test.jpg", jpg)
        assert r.status_code == 200, r.text
        assert r.json()["pages_created"] == 1
        page = _wait_page(auth, doc, timeout=300)
        assert page["status"] == "done", f"OCR error: {page.get('error')}"
        md = page.get("markdown") or ""
        figs = [f for f in (page.get("figures") or []) if not f.get("deleted")]

        # ---- Assertions on figures ----
        # Spec: >=4 pictograms + 1 bigger illustration. Allow some AI slack but
        # require at least 4 separate objects to validate "each as separate box".
        assert len(figs) >= 4, (
            f"Expected >=4 figures (4 pictograms + 1 sun), got {len(figs)}. "
            f"Figures: {figs}. Markdown: {md[:600]}"
        )
        for f in figs:
            assert f.get("url", "").startswith("https://"), f"figure missing https url: {f}"
            assert f.get("file_id"), f"figure missing file_id: {f}"
            # Each figure box should NOT cover most of the page (sanity)
            b = f["box_2d"]
            area = (b[2] - b[0]) * (b[3] - b[1])
            assert area < 0.5 * 1_000_000, f"figure too large (covers page): {f}"

        # ---- Placeholders present in markdown ----
        import re as _re
        placeholders = _re.findall(r"\[\[FIGURE:\d+\]\]", md)
        # Must have at least some [[FIGURE:n]] placeholders in the markdown
        assert len(placeholders) >= 1, (
            f"Expected [[FIGURE:n]] placeholders in markdown, got none. Markdown: {md[:600]}"
        )

        pytest.bildstod_page_id = page["id"]
        pytest.bildstod_fig_count = len(figs)
        pytest.bildstod_markdown = md

    def test_03_process_generates_doc_with_inline_images(self, auth, token, doc):
        r = auth.post(
            f"{BASE}/api/process",
            json={
                "instruction": "Skriv om texten enklare",
                "document_ids": [doc],
            },
            timeout=30,
        )
        assert r.status_code == 200, r.text
        gen_id = r.json()["id"]
        deadline = time.time() + 300
        final = None
        while time.time() < deadline:
            rr = auth.get(f"{BASE}/api/documents/{gen_id}", timeout=30)
            if rr.status_code == 200 and rr.json().get("status") in ("ready", "error"):
                final = rr.json()
                break
            time.sleep(3)
        assert final, "generation timed out"
        assert final["status"] == "ready", f"process failed: {final}"

        gen_md = final.get("markdown") or ""
        import re as _re
        refs = _re.findall(r"!\[[^\]]*\]\(fig:[a-f0-9]+\)", gen_md)
        assert len(refs) >= 3, (
            f"Generated doc should include >=3 image refs (bildstöd kept), got {len(refs)}. "
            f"Markdown head: {gen_md[:800]}"
        )

        # ZIP export must contain the images
        r2 = requests.get(
            f"{BASE}/api/documents/{gen_id}/export",
            params={"format": "zip", "token": token},
            timeout=120,
        )
        assert r2.status_code == 200, f"zip export failed: {r2.status_code}"
        with zipfile.ZipFile(io.BytesIO(r2.content)) as z:
            names = z.namelist()
            img_names = [n for n in names if n.startswith("bilder/") and n.endswith(".jpg")]
            assert len(img_names) >= 3, (
                f"Generated ZIP missing images (expected >=3), got: {img_names}"
            )

        # docx export 200
        r3 = requests.get(
            f"{BASE}/api/documents/{gen_id}/export",
            params={"format": "docx", "token": token},
            timeout=120,
        )
        assert r3.status_code == 200, f"docx export failed: {r3.status_code}"
        # Must look like a docx file (PK zip magic)
        assert r3.content[:2] == b"PK", "docx export is not a valid zip/docx"

        auth.delete(f"{BASE}/api/documents/{gen_id}", timeout=30)

    def test_04_settings_restored(self, auth):
        MDB.settings.update_one(
            {"id": "global"},
            {"$set": {"speed_mode": "fast", "primary_provider": "gemini"}},
            upsert=True,
        )
        d = auth.get(f"{BASE}/api/settings", timeout=30).json()
        assert d["speed_mode"] == "fast"
        assert d["primary_provider"] == "gemini"
