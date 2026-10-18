"""Iteration 11: unit + real-AI tests for grow_box / dedupe_boxes / drop_whole_page / refine_figures.

grow_box now only expands across a clearly saturated panel colour (max-min >= 60
in RGB); neutral white/cream/grey/black never grow. drop_whole_page removes
boxes covering >=60% of the page. dedupe_boxes still drops nested boxes.

- Unit: grow_box synthetic red panel from a small logo box -> ~[143,200,429,800].
- Unit: grow_box on dark/neutral page (dark grey bg + cream rectangle) does NOT grow.
- Unit: drop_whole_page removes a [0,0,1000,1000] box; dedupe_boxes drops a fully
        nested box but keeps two partly-overlapping separate boxes (panel + cow).
- Real AI (<=2 OCR uploads): synthetic Arla-like product photo (dark background,
  cream carton rectangle, red "Arla / Laktos FRI" badge, separate drawn cow
  shape below the badge) -> >=2 figures, none covering >=60% of the page,
  none nested.
- Regression: ZIP export still packages bilder/*.jpg + bilder/bildtexter.txt.
"""
import io
import os
import time
import random
from pathlib import Path

import pytest
import requests
import pymongo
from PIL import Image, ImageDraw
from dotenv import load_dotenv

# Local imports (direct unit test of pipeline helpers)
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pipeline import grow_box, dedupe_boxes, drop_whole_page  # noqa: E402

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
load_dotenv(Path(__file__).resolve().parent.parent.parent / "frontend" / ".env")

BASE = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/").strip('"')
MDB = pymongo.MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]


# ---------- synthetic helpers ----------
def _red_panel_page(size=(2000, 2800)) -> Image.Image:
    """White page: red rectangle [400,400]-[1600,1200] with a WHITE logo
    ellipse in the middle; paragraph text block below at y>=1300."""
    w, h = size
    im = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(im)
    d.rectangle([400, 400, 1600, 1200], fill=(220, 40, 40))
    d.ellipse([900, 700, 1100, 900], fill="white")
    for i in range(20):
        d.text((200, 1300 + i * 30), "Detta ar text" * 5, fill="black")
    return im


def _logo_box_1000() -> list[float]:
    """0-1000 box of the small white logo ellipse inside the red panel."""
    return [250.0, 450.0, 321.4, 550.0]


def _neutral_page_with_cream() -> Image.Image:
    """Dark grey page (40,40,40) with a cream carton rectangle (240,230,210).
    Both colours are 'neutral' (max-min < 60) so grow_box should refuse to grow."""
    im = Image.new("RGB", (2000, 2800), (40, 40, 40))
    d = ImageDraw.Draw(im)
    d.rectangle([300, 400, 1500, 1800], fill=(240, 230, 210))
    return im


# ---------- unit tests ----------
class TestGrowBox:
    def test_grow_box_expands_to_red_panel(self):
        im = _red_panel_page()
        grown = grow_box(im, _logo_box_1000())
        # Expected around [143,200,429,800].
        assert 100 <= grown[0] <= 170, f"ymin out of range: {grown}"
        assert 180 <= grown[1] <= 230, f"xmin out of range: {grown}"
        assert 400 <= grown[2] <= 460, f"ymax out of range: {grown}"
        assert 770 <= grown[3] <= 820, f"xmax out of range: {grown}"
        # Must NOT grow into the paragraph text block (which starts at y=1300 -> 464).
        assert grown[2] < 464, f"grew into the text block: {grown}"

    def test_grow_box_on_neutral_background_does_not_grow(self):
        """Dark grey bg + cream rectangle: max-min of edge colour < 60 -> no growth."""
        im = _neutral_page_with_cream()
        # Box fully inside the cream rectangle (cream = neutral)
        cream_box = [220.0, 170.0, 500.0, 700.0]
        grown = grow_box(im, cream_box)
        assert grown == cream_box, (
            f"grow_box must not grow on a neutral panel; got {grown} from {cream_box}"
        )
        # Box fully inside the dark grey bg (also neutral)
        grey_box = [800.0, 800.0, 900.0, 900.0]
        grown2 = grow_box(im, grey_box)
        assert grown2 == grey_box, (
            f"grow_box must not grow on neutral dark grey; got {grown2}"
        )


class TestDedupeAndDropWholePage:
    def test_drop_whole_page_removes_full_page_box(self):
        figs = [
            {"n": 1, "box_2d": [0, 0, 1000, 1000], "caption": "everything"},
            {"n": 2, "box_2d": [100, 100, 300, 300], "caption": "small"},
        ]
        kept = drop_whole_page(figs)
        assert [k["n"] for k in kept] == [2]

    def test_drop_whole_page_removes_60pct_box(self):
        # A box covering exactly 60% of area must be dropped (strict < 0.6 kept)
        big = {"n": 1, "box_2d": [100, 100, 900, 900], "caption": "big"}  # 0.64 area
        small = {"n": 2, "box_2d": [100, 100, 300, 300], "caption": "small"}
        kept = drop_whole_page([big, small])
        assert [k["n"] for k in kept] == [2]

    def test_dedupe_drops_nested_but_keeps_two_overlapping_separate(self):
        """Panel + cow partially overlap (both separate images), one small box is
        fully nested inside the panel and must be dropped."""
        panel = {"n": 1, "box_2d": [100, 100, 500, 500], "caption": "panel"}
        cow = {"n": 2, "box_2d": [400, 400, 700, 700], "caption": "cow"}  # 10% overlap w/ panel
        nested = {"n": 3, "box_2d": [150, 150, 250, 250], "caption": "nested"}
        kept = dedupe_boxes([panel, cow, nested])
        ns = sorted(k["n"] for k in kept)
        assert ns == [1, 2], f"expected panel+cow, nested dropped. got {ns}"


# ---------- real-AI test ----------
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
    r = auth.post(f"{BASE}/api/courses", json={"name": "TEST_GROW_Course"}, timeout=30)
    assert r.status_code == 200, r.text
    cid = r.json()["id"]
    yield cid
    auth.delete(f"{BASE}/api/courses/{cid}", timeout=30)


@pytest.fixture(scope="module")
def doc(auth, course):
    r = auth.post(
        f"{BASE}/api/documents",
        json={"course_id": course, "title": "TEST_GROW_Doc"},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    did = r.json()["id"]
    yield did
    auth.delete(f"{BASE}/api/documents/{did}", timeout=30)


def _carton_photo_bytes() -> bytes:
    """Synthetic product photo: dark room background, cream carton rectangle,
    red Arla-like badge with 'Arla / Laktos FRI' text, and a separate drawn
    cow-like shape BELOW the badge. We want the AI to find the badge AND the
    cow as separate figures (>=2), neither of them covering the whole photo."""
    random.seed(11)
    W, H = 2000, 2800
    im = Image.new("RGB", (W, H), (28, 30, 34))  # dark room bg
    # Add a bit of noise so it looks photo-like
    px = im.load()
    for _ in range(4000):
        x, y = random.randint(0, W - 1), random.randint(0, H - 1)
        v = random.randint(-20, 20)
        r, g, b = px[x, y]
        px[x, y] = (max(0, min(255, r + v)), max(0, min(255, g + v)), max(0, min(255, b + v)))

    d = ImageDraw.Draw(im)
    # Cream carton rectangle (neutral — grow_box will not swallow it)
    d.rectangle([400, 300, 1600, 2500], fill=(242, 232, 212))
    # Dark border around the carton to give it photo-like depth
    d.rectangle([400, 300, 1600, 2500], outline=(60, 50, 30), width=8)
    # Red Arla-like rounded badge (very saturated, strong black border,
    # white text — makes it look like a brand badge/logo, not just a shape).
    for off in range(10):  # fake shadow
        d.rectangle([550 + off, 500 + off, 1450 + off, 1100 + off],
                    fill=(10, 10, 10) if off == 9 else None)
    d.rectangle([550, 500, 1450, 1100], fill=(205, 35, 45), outline="black", width=10)
    # Bold white "Arla" and "Laktos FRI" text — scale with ImageDraw default font
    # by drawing multiple times to approximate boldness.
    for dx, dy in [(0, 0), (1, 0), (0, 1), (2, 1), (1, 2)]:
        try:
            d.text((760 + dx, 620 + dy), "Arla", fill="white")
            d.text((700 + dx, 880 + dy), "Laktos FRI", fill="white")
        except Exception:
            pass
    # Separate drawn COW shape BELOW the badge (black outline body + head + legs
    # on cream carton -> different element, not inside the red panel)
    # body
    d.ellipse([700, 1300, 1300, 1700], outline="black", width=6, fill=(250, 250, 250))
    # head
    d.ellipse([1250, 1350, 1500, 1600], outline="black", width=6, fill=(250, 250, 250))
    # legs
    for lx in (780, 900, 1100, 1220):
        d.rectangle([lx, 1680, lx + 40, 1850], outline="black", width=4, fill=(250, 250, 250))
    # spots
    d.ellipse([800, 1400, 900, 1500], fill="black")
    d.ellipse([1050, 1480, 1150, 1580], fill="black")

    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=92)
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


def _wait_page(auth, did, timeout=240):
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


def _area(b):
    return max(0, b[2] - b[0]) * max(0, b[3] - b[1])


def _inter(a, b):
    return _area([max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])])


class TestRealAIFigures:
    """One real Gemini OCR call to verify end-to-end refine_figures()."""

    def test_01_settings_fast_gemini(self, auth):
        MDB.settings.update_one(
            {"id": "global"},
            {"$set": {"speed_mode": "fast", "primary_provider": "gemini"}},
            upsert=True,
        )
        d = auth.get(f"{BASE}/api/settings", timeout=30).json()
        assert d["speed_mode"] == "fast"
        assert d["primary_provider"] == "gemini"

    def test_02_carton_photo_two_figures_no_nest_no_whole_page(self, auth, token, doc):
        jpg = _carton_photo_bytes()
        r = _upload(auth, token, doc, "arla_carton.jpg", jpg)
        assert r.status_code == 200, r.text
        assert r.json()["pages_created"] == 1

        page = _wait_page(auth, doc, timeout=240)
        assert page["status"] == "done", f"OCR error: {page.get('error')}"
        figs = [f for f in (page.get("figures") or []) if not f.get("deleted")]
        assert len(figs) >= 2, (
            f"Expected >=2 figures (red badge + cow), got {len(figs)}: "
            f"{[f.get('box_2d') for f in figs]}"
        )

        # None covers >=60% of the page (drop_whole_page guarantee).
        page_area = 1_000_000
        for f in figs:
            a = _area(f["box_2d"])
            assert a / page_area < 0.6, (
                f"Figure covers {a/page_area:.1%} of page: {f['box_2d']}"
            )

        # No box lies >=60% inside another (dedupe_boxes guarantee)
        for i, a in enumerate(figs):
            for j, b in enumerate(figs):
                if i == j:
                    continue
                ar = _area(a["box_2d"]) or 1
                assert _inter(a["box_2d"], b["box_2d"]) / ar < 0.6, (
                    f"figure {i} nested inside figure {j}: "
                    f"{a['box_2d']} vs {b['box_2d']}"
                )

        # Every figure must have an https CommHub crop URL
        for f in figs:
            assert f["url"].startswith("https://"), f["url"]
            assert f.get("file_id")

    def test_03_zip_still_contains_bilder(self, auth, token, doc):
        import zipfile
        r = requests.get(
            f"{BASE}/api/documents/{doc}/export",
            params={"format": "zip", "token": token},
            timeout=90,
        )
        assert r.status_code == 200
        with zipfile.ZipFile(io.BytesIO(r.content)) as z:
            names = z.namelist()
            img_names = [n for n in names if n.startswith("bilder/") and n.endswith(".jpg")]
            assert img_names, f"ZIP missing bilder/*.jpg, got: {names}"
            assert "bilder/bildtexter.txt" in names

    def test_04_settings_pinned(self, auth):
        d = auth.get(f"{BASE}/api/settings", timeout=30).json()
        assert d["speed_mode"] == "fast"
        assert d["primary_provider"] == "gemini"
