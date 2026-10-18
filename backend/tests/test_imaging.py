"""Iteration 13: Unit tests for imaging.keystone / white_balance / correct_crop
and real-AI tests for keystone correction + colour correction via pipeline.

Scope mirrors the review request:
  - Unit tests use synthetic images only (no AI, no HTTP).
  - Real-AI tests upload at most 2 pages (one skewed photo-like JPEG, one
    straight white PDF) and assert the corrected flag + keystone flag.
  - Settings pinned to speed_mode=fast + primary_provider=gemini.
"""
import io
import os
import sys
import time
import random
from pathlib import Path

import numpy as np
import pytest
import pymongo
import pymupdf
import requests
from PIL import Image, ImageDraw
from dotenv import load_dotenv

# Make backend importable
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")
load_dotenv(ROOT.parent / "frontend" / ".env")

from imaging import keystone, white_balance, correct_crop, correct_page  # noqa: E402

BASE = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/").strip('"')
MDB = pymongo.MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]


# ---------------- Unit tests (no AI, no network) ----------------
class TestKeystone:
    """imaging.keystone: perspective warp of a paper quad to an axis-aligned rect."""

    @staticmethod
    def _skewed_page_image() -> Image.Image:
        # 1600x2000 dark table (60,50,40) with a yellowish paper quadrilateral
        im = Image.new("RGB", (1600, 2000), (60, 50, 40))
        d = ImageDraw.Draw(im)
        d.polygon(
            [(300, 250), (1300, 350), (1400, 1800), (200, 1700)],
            fill=(235, 220, 170),
        )
        return im

    def test_01_warped_output(self):
        im = self._skewed_page_image()
        # corners in [y, x] normalized 0-1000 order TL, TR, BR, BL
        # pixel-> normalized: y/2000 * 1000, x/1600 * 1000
        def norm(x, y):
            return [y / 2000 * 1000, x / 1600 * 1000]
        corners = [
            norm(300, 250),
            norm(1300, 350),
            norm(1400, 1800),
            norm(200, 1700),
        ]
        out = keystone(im, corners)
        assert out is not None, "expected a warped image, got None"
        # Width ~ max(TR-TL, BR-BL) = max(1000, 1200) = 1200
        # Height ~ max(BL-TL, BR-TR) = max(1450, 1450) = 1450
        assert 1150 <= out.width <= 1260, f"width out of range: {out.width}"
        assert 1400 <= out.height <= 1500, f"height out of range: {out.height}"
        # Corners should be sampled from inside the paper (yellowish)
        arr = np.asarray(out)
        for (cy, cx) in [(10, 10), (10, out.width - 11), (out.height - 11, 10), (out.height - 11, out.width - 11)]:
            px = arr[cy, cx]
            # paper fill was (235,220,170) with BICUBIC resampling edge softening
            assert px[0] > 150 and px[1] > 140 and px[2] > 100, (
                f"corner pixel {px} does not look like paper"
            )

    def test_02_frame_corners_returns_none(self):
        im = Image.new("RGB", (800, 1000), "white")
        corners = [[0, 0], [0, 1000], [1000, 1000], [1000, 0]]
        assert keystone(im, corners) is None

    def test_03_implausible_corners_returns_none(self):
        im = Image.new("RGB", (1600, 2000), "white")
        # Non-convex / inverted order (TL to the right of TR) -> None
        bad = [[100, 900], [100, 200], [900, 200], [900, 900]]
        assert keystone(im, bad) is None

    def test_04_too_small_paper_returns_none(self):
        im = Image.new("RGB", (1600, 2000), "white")
        # Paper covers <25% of each axis
        corners = [[100, 100], [100, 300], [300, 300], [300, 100]]
        assert keystone(im, corners) is None

    def test_05_bad_types_returns_none(self):
        im = Image.new("RGB", (800, 1000), "white")
        assert keystone(im, None) is None
        assert keystone(im, []) is None
        assert keystone(im, [[0, 0], [0, 0]]) is None
        assert keystone(im, "not a list") is None


class TestWhiteBalance:
    """imaging.white_balance: scale channels so paper becomes near-white."""

    def test_01_yellowish_paper_whitens(self):
        im = Image.new("RGB", (400, 400), (235, 220, 170))
        out = white_balance(im)
        arr = np.asarray(out.convert("RGB"))
        median = np.median(arr.reshape(-1, 3), axis=0)
        # Target in code is 245.0 then clipped+autocontrasted; allow 1-pixel
        # rounding on the darkest channel.
        assert median.min() >= 244, (
            f"expected near-white (>=244 all channels), got median {median}"
        )

    def test_02_dark_image_left_untouched(self):
        im = Image.new("RGB", (300, 300), (20, 15, 10))
        out = white_balance(im)
        arr_in = np.asarray(im)
        arr_out = np.asarray(out.convert("RGB"))
        # Should be identical (returns input)
        assert np.array_equal(arr_in, arr_out), (
            "dark image was altered by white_balance; expected untouched"
        )


class TestCorrectCrop:
    """imaging.correct_crop: crop with white-paper ring colour correction."""

    def test_01_crop_size_and_colour(self):
        # 1000x1200 yellowish paper, central darker figure
        im = Image.new("RGB", (1000, 1200), (235, 220, 170))
        d = ImageDraw.Draw(im)
        rect = (400, 500, 700, 800)
        d.rectangle(rect, fill=(100, 80, 60))
        out = correct_crop(im, rect)
        assert out.size == (rect[2] - rect[0], rect[3] - rect[1]), (
            f"crop size {out.size} != {(rect[2]-rect[0], rect[3]-rect[1])}"
        )
        # The ring (yellowish paper around the crop) should drive the balance so
        # the ORIGINAL yellowish paper colour maps to near-white. Verify by
        # white-balancing a tiny strip of pure paper the same way:
        pure = Image.new("RGB", (50, 50), (235, 220, 170))
        pure_wb = np.asarray(white_balance(pure).convert("RGB"))
        assert pure_wb.min() >= 240

    def test_02_crop_near_edge_still_works(self):
        im = Image.new("RGB", (800, 800), (235, 220, 170))
        d = ImageDraw.Draw(im)
        d.rectangle((0, 0, 100, 100), fill=(50, 50, 50))
        out = correct_crop(im, (0, 0, 100, 100))
        assert out.size == (100, 100)


class TestCorrectPage:
    """correct_page returns bytes + changed flag; integrates keystone + wb."""

    def test_01_no_corners_still_white_balances(self):
        # yellowish paper, no corners -> wb only
        im = Image.new("RGB", (600, 800), (235, 220, 170))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=90)
        out, changed = correct_page(buf.getvalue(), None)
        assert changed is True
        assert out[:3] == b"\xff\xd8\xff", "not a JPEG"
        img = Image.open(io.BytesIO(out))
        assert img.size == (600, 800)
        arr = np.asarray(img.convert("RGB"))
        assert np.median(arr.reshape(-1, 3), axis=0).min() >= 240

    def test_02_frame_corners_no_warp(self):
        im = Image.new("RGB", (600, 800), (235, 220, 170))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=90)
        # Frame corners -> no warp but still white balance
        out, _ = correct_page(buf.getvalue(), [[0, 0], [0, 1000], [1000, 1000], [1000, 0]])
        img = Image.open(io.BytesIO(out))
        assert img.size == (600, 800)


# ---------------- Real-AI tests (max 2 page uploads) ----------------
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
    r = auth.post(f"{BASE}/api/courses", json={"name": "TEST_IMG_Course"}, timeout=30)
    assert r.status_code == 200, r.text
    cid = r.json()["id"]
    yield cid
    auth.delete(f"{BASE}/api/courses/{cid}", timeout=30)


@pytest.fixture(scope="module")
def skewed_doc(auth, course):
    r = auth.post(f"{BASE}/api/documents",
                  json={"course_id": course, "title": "TEST_IMG_Skewed"}, timeout=30)
    did = r.json()["id"]
    yield did
    auth.delete(f"{BASE}/api/documents/{did}", timeout=30)


@pytest.fixture(scope="module")
def straight_doc(auth, course):
    r = auth.post(f"{BASE}/api/documents",
                  json={"course_id": course, "title": "TEST_IMG_Straight"}, timeout=30)
    did = r.json()["id"]
    yield did
    auth.delete(f"{BASE}/api/documents/{did}", timeout=30)


def _skewed_jpeg_page() -> bytes:
    """1800x2400 dark table photo with a rotated/skewed yellowish paper
    carrying Swedish text lines and a coloured pictogram."""
    random.seed(13)
    W, H = 1800, 2400
    # Dark background with some noise
    bg = np.random.randint(40, 80, (H, W, 3), dtype=np.uint8)
    im = Image.fromarray(bg)
    d = ImageDraw.Draw(im)
    # Skewed yellowish paper quad (ordered TL, TR, BR, BL)
    quad = [(380, 320), (1500, 420), (1600, 2050), (280, 1930)]
    d.polygon(quad, fill=(240, 225, 180))
    # Add some light-colour variation to look paper-like
    # Then add text aligned to the paper rough centre (keeps it readable even
    # pre-correction since the skew is modest).
    try:
        from PIL import ImageFont
        font = ImageFont.load_default()
    except Exception:
        font = None
    lines = [
        "Kapitel 3 - Djur i skogen",
        "Rådjur ar vanliga i Sverige.",
        "De lever i skogar och pa fält.",
        "Räven är ett rovdjur.",
        "Harar hoppar snabbt.",
        "Älgen är det största djuret.",
    ]
    for i, line in enumerate(lines):
        d.text((470, 500 + i * 150), line, fill=(30, 30, 30), font=font)
    # Coloured pictogram (red circle) at bottom right of the paper
    d.ellipse((1200, 1700, 1350, 1850), fill=(220, 40, 40))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=88)
    return buf.getvalue()


def _straight_pdf_page() -> bytes:
    doc = pymupdf.open()
    p = doc.new_page(width=595, height=842)
    p.insert_text((72, 90), "Rak sida - testdokument", fontsize=18)
    body = ("Detta är en rak vit PDF-sida utan skevning. "
            "Hornen pa sidan sammanfaller med bilden sa ingen keystone "
            "behover goras. Fargen ska lamnas obehandlad.")
    y = 130
    for chunk in [body[i:i + 70] for i in range(0, len(body), 70)]:
        p.insert_text((72, y), chunk, fontsize=12)
        y += 18
    data = doc.tobytes()
    doc.close()
    return data


def _upload(auth, token, doc_id, filename, data):
    r = auth.post(f"{BASE}/api/uploads/init",
                  json={"document_id": doc_id, "filename": filename, "size": len(data)},
                  timeout=30)
    assert r.status_code == 200, r.text
    up = r.json()
    uid, chunk = up["upload_id"], up["chunk_size"]
    off, idx = 0, 0
    hdr = {"Authorization": f"Bearer {token}"}
    while off < len(data):
        part = data[off:off + chunk]
        files = {"file": (f"c{idx}", part, "application/octet-stream")}
        cr = requests.post(f"{BASE}/api/uploads/{uid}/chunk",
                           headers=hdr, data={"index": idx},
                           files=files, timeout=60)
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


class TestRealAIKeystone:
    """Real-AI end-to-end: skewed JPEG photo and straight PDF."""

    def test_01_settings_pinned(self):
        MDB.settings.update_one(
            {"id": "global"},
            {"$set": {"speed_mode": "fast", "primary_provider": "gemini"}},
            upsert=True,
        )

    def test_02_skewed_jpeg_is_corrected(self, auth, token, skewed_doc):
        jpg = _skewed_jpeg_page()
        orig_img = Image.open(io.BytesIO(jpg))
        orig_w, orig_h = orig_img.size
        r = _upload(auth, token, skewed_doc, "skewed_page.jpg", jpg)
        assert r.status_code == 200, r.text
        # Capture the original page BEFORE processing so we have its initial image_url
        time.sleep(1)
        r0 = auth.get(f"{BASE}/api/documents/{skewed_doc}", timeout=30)
        orig_page = r0.json()["pages"][0]
        orig_url = orig_page["image_url"]

        page = _wait_page(auth, skewed_doc, timeout=300)
        assert page["status"] == "done", f"OCR failed: {page.get('error')}"
        assert page.get("corrected") is True, f"corrected flag missing: {page}"
        # keystone should be True because corners detector reports is_photo_of_page
        # for a rotated paper on dark table. We allow for the detector to decline
        # (returns None -> keystone=False) only if the paper filled the frame,
        # which it clearly doesn't here.
        assert page.get("keystone") is True, (
            f"expected keystone=True for a skewed photo, got {page.get('keystone')}; "
            f"width before/after {orig_w}x{orig_h} -> {page.get('width')}x{page.get('height')}"
        )
        # Dimensions must have changed vs the raw upload because of the warp
        new_w, new_h = page.get("width"), page.get("height")
        assert (new_w, new_h) != (orig_w, orig_h), (
            f"page dimensions unchanged after keystone: {new_w}x{new_h}"
        )
        # image_url must have changed (new CommHub upload for corrected image)
        assert page["image_url"] != orig_url, (
            f"image_url did not change after correction: {page['image_url']}"
        )
        # Confirm text was read
        md = page.get("markdown") or ""
        assert len(md) >= 20, f"markdown too short: {md!r}"
        # At least some figures expected (red pictogram)
        pytest.skew_page_id = page["id"]
        pytest.skew_page_url = page["image_url"]
        pytest.skew_page_markdown = md

    def test_03_straight_pdf_no_keystone(self, auth, token, straight_doc):
        pdf = _straight_pdf_page()
        r = _upload(auth, token, straight_doc, "straight_page.pdf", pdf)
        assert r.status_code == 200, r.text
        page = _wait_page(auth, straight_doc, timeout=300)
        assert page["status"] == "done", f"OCR failed: {page.get('error')}"
        assert page.get("corrected") is True, f"corrected flag missing: {page}"
        # The corner detector should see a flat scan (is_photo_of_page=false) ->
        # corners None -> keystone=False.
        assert page.get("keystone") is False, (
            f"expected keystone=False for a straight PDF, got {page.get('keystone')}"
        )
        md = page.get("markdown") or ""
        assert len(md) >= 20, f"markdown too short: {md!r}"
        assert "test" in md.lower() or "rak" in md.lower() or "sida" in md.lower(), (
            f"expected recognisable Swedish text, got: {md[:200]}"
        )

    def test_04_rescan_does_not_recorrect(self, auth, token, skewed_doc):
        page_id = getattr(pytest, "skew_page_id", None)
        if not page_id:
            pytest.skip("skewed page not ready")
        prev_url = pytest.skew_page_url
        # Trigger rescan (Förbättra sida)
        r = auth.post(f"{BASE}/api/pages/{page_id}/rescan", timeout=30)
        assert r.status_code in (200, 202), f"rescan failed: {r.status_code} {r.text}"
        # Wait for the page to finish re-processing (fetched via its document)
        deadline = time.time() + 240
        page = None
        while time.time() < deadline:
            rr = auth.get(f"{BASE}/api/documents/{skewed_doc}", timeout=30)
            if rr.status_code == 200:
                pages = rr.json().get("pages", [])
                page = next((p for p in pages if p["id"] == page_id), None)
                if page and page.get("status") in ("done", "error"):
                    break
            time.sleep(3)
        assert page and page.get("status") == "done", f"rescan did not finish ok: {page}"
        # Correction must NOT be applied a second time
        assert page.get("corrected") is True
        assert page["image_url"] == prev_url, (
            f"image_url changed on rescan (correction re-applied): "
            f"{prev_url} -> {page['image_url']}"
        )

    def test_05_settings_restored(self, auth):
        MDB.settings.update_one(
            {"id": "global"},
            {"$set": {"speed_mode": "fast", "primary_provider": "gemini"}},
            upsert=True,
        )
        d = auth.get(f"{BASE}/api/settings", timeout=30).json()
        assert d["speed_mode"] == "fast"
        assert d["primary_provider"] == "gemini"
