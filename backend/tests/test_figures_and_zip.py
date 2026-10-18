"""Iteration 9: real-AI figure extraction + ZIP export of all extracted images.

Scenario:
  1. Build a PDF with Swedish text + an embedded photo-like image (noise/gradient
     JPEG inserted with pymupdf) and upload it.
  2. OCR runs (1 real Gemini call). If the reading pass returns no figures,
     pipeline.process_page falls back to detect_figures() to find the photo.
     Expect >=1 figure on the page with CommHub url/file_id.
  3. Download /export?format=zip and assert bilder/sida_01_bild_01.jpg +
     bilder/bildtexter.txt exist with the caption line.
  4. PATCH /pages/{id} to remove the [[FIGURE:n]] placeholder from the markdown
     and verify the image is STILL in the ZIP (build_files includes every
     non-deleted figure, not only those referenced in markdown).
  5. Toggle the figure deleted=true -> ZIP no longer contains it.
  6. Restore the figure -> POST /process (1 real AI call) -> wait for ready ->
     verify source_figures contains the image id and generated-doc ZIP contains
     bild_01.jpg.

Settings must stay speed_mode=fast + primary_provider=gemini.
Total paid AI calls: 2 (one OCR, one /process). Well under budget of 3.
"""
import io
import os
import time
import zipfile
import random
from pathlib import Path

import pytest
import requests
import pymongo
import pymupdf
from PIL import Image
from dotenv import load_dotenv

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
    r = auth.post(f"{BASE}/api/courses", json={"name": "TEST_FIG_Course"}, timeout=30)
    assert r.status_code == 200, r.text
    cid = r.json()["id"]
    yield cid
    auth.delete(f"{BASE}/api/courses/{cid}", timeout=30)


@pytest.fixture(scope="module")
def doc(auth, course):
    r = auth.post(
        f"{BASE}/api/documents",
        json={"course_id": course, "title": "TEST_FIG_Doc"},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    did = r.json()["id"]
    yield did
    auth.delete(f"{BASE}/api/documents/{did}", timeout=30)


# ---------- helpers ----------
def _photo_jpeg() -> bytes:
    """Noise + gradient photo-like JPEG (clearly a picture, not text/line art)."""
    random.seed(42)
    img = Image.new("RGB", (600, 450))
    px = img.load()
    for y in range(450):
        for x in range(600):
            r = int(80 + (x / 600) * 160 + random.randint(-15, 15))
            g = int(140 + (y / 450) * 100 + random.randint(-15, 15))
            b = int(40 + ((x + y) / 1050) * 180 + random.randint(-15, 15))
            px[x, y] = (max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b)))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=90)
    return buf.getvalue()


def _pdf_with_photo() -> bytes:
    """A4 PDF: Swedish heading + body text + an inserted photo-like JPEG."""
    doc = pymupdf.open()
    p = doc.new_page(width=595, height=842)
    p.insert_text((520, 40), "12", fontsize=12)  # printed page number
    p.insert_text((72, 90), "Mjölkförpackning – näringsinnehåll", fontsize=18)
    body = (
        "Produktbilden nedan visar en typisk mjölkförpackning. "
        "Mjölken innehåller protein, kalcium och vitamin D. "
        "Fetthalten varierar mellan 0.5% och 3% beroende på sort."
    )
    y = 130
    for chunk in [body[i:i + 70] for i in range(0, len(body), 70)]:
        p.insert_text((72, y), chunk, fontsize=12)
        y += 18

    # Insert the photo-like image as an actual embedded image
    img_rect = pymupdf.Rect(150, 300, 450, 525)
    p.insert_image(img_rect, stream=_photo_jpeg())
    p.insert_text((150, 545), "Figur 1: Produktbild av mjölkförpackning", fontsize=10)

    p.insert_text((72, 600), "Källa: Livsmedelsverket.", fontsize=12)
    data = doc.tobytes()
    doc.close()
    return data


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


def _download_zip(token, did):
    r = requests.get(
        f"{BASE}/api/documents/{did}/export",
        params={"format": "zip", "token": token},
        timeout=90,
    )
    assert r.status_code == 200, f"zip export failed: {r.status_code} {r.text[:200]}"
    assert "zip" in r.headers.get("content-type", ""), r.headers
    return zipfile.ZipFile(io.BytesIO(r.content))


# ---------- tests ----------
class TestFiguresAndZip:
    """Full flow for user story: 'Bilder extraheras inte och läggs separat'."""

    def test_01_settings_fast_gemini(self, auth):
        MDB.settings.update_one(
            {"id": "global"},
            {"$set": {"speed_mode": "fast", "primary_provider": "gemini"}},
            upsert=True,
        )
        d = auth.get(f"{BASE}/api/settings", timeout=30).json()
        assert d["speed_mode"] == "fast"
        assert d["primary_provider"] == "gemini"

    def test_02_upload_and_ocr_finds_photo(self, auth, token, doc):
        pdf = _pdf_with_photo()
        r = _upload(auth, token, doc, "mjolk_test.pdf", pdf)
        assert r.status_code == 200, r.text
        assert r.json()["pages_created"] == 1
        page = _wait_page(auth, doc, timeout=240)
        assert page["status"] == "done", f"OCR error: {page.get('error')}"
        md = page.get("markdown") or ""
        assert len(md) > 20

        figs = [f for f in (page.get("figures") or []) if not f.get("deleted")]
        assert len(figs) >= 1, (
            f"Expected >=1 figure on milk-carton page, got {page.get('figures')}. "
            f"Markdown: {md[:400]}"
        )
        first = figs[0]
        assert first.get("url", "").startswith("https://"), f"figure missing url: {first}"
        assert first.get("file_id"), f"figure missing file_id: {first}"
        assert isinstance(first.get("n"), int)
        # Store for later tests
        pytest.fig_page_id = page["id"]
        pytest.fig_id = first["id"]
        pytest.fig_n = first["n"]
        pytest.fig_markdown = md

    def test_03_zip_contains_figures_folder(self, token, doc):
        page_id = getattr(pytest, "fig_page_id", None)
        if not page_id:
            pytest.skip("page not ready")
        with _download_zip(token, doc) as z:
            names = z.namelist()
            img_names = [n for n in names if n.startswith("bilder/") and n.endswith(".jpg")]
            assert img_names, f"zip missing bilder/*.jpg, got: {names}"
            # Expected naming pattern: sida_01_bild_01.jpg
            assert any(
                "sida_01_bild_" in n for n in img_names
            ), f"expected sida_01_bild_NN.jpg naming, got {img_names}"
            # bildtexter.txt
            assert "bilder/bildtexter.txt" in names, f"missing bildtexter.txt: {names}"
            caps = z.read("bilder/bildtexter.txt").decode("utf-8")
            assert img_names[0].split("/")[-1] in caps, f"caption line missing filename: {caps}"
            # Image bytes should be a valid JPEG (>500 bytes)
            data = z.read(img_names[0])
            assert len(data) > 500
            assert data[:3] == b"\xff\xd8\xff", "not a JPEG"
            pytest.first_zip_img = img_names[0]

    def test_04_remove_placeholder_still_in_zip(self, auth, token, doc):
        """If [[FIGURE:n]] is removed from markdown via PATCH, the image is
        still included in the ZIP (build_files uses figures list, not refs)."""
        page_id = getattr(pytest, "fig_page_id", None)
        if not page_id:
            pytest.skip("page not ready")
        md = getattr(pytest, "fig_markdown", "")
        import re as _re
        stripped = _re.sub(r"\[\[FIGURE:\d+\]\]", "", md).strip()
        if stripped == md.strip():
            # No placeholder present (e.g. detect_figures didn't append) - still fine; set it to a
            # plain-text version with no fig: refs either.
            stripped = _re.sub(r"!\[[^\]]*\]\(fig:[a-f0-9]+\)", "", stripped).strip()
        r = auth.patch(
            f"{BASE}/api/pages/{page_id}",
            json={"markdown": stripped},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        with _download_zip(token, doc) as z:
            names = z.namelist()
            img_names = [n for n in names if n.startswith("bilder/") and n.endswith(".jpg")]
            assert img_names, f"ZIP must still contain extracted images even without placeholder, got: {names}"

    def test_05_toggle_deleted_removes_from_zip(self, auth, token, doc):
        page_id = getattr(pytest, "fig_page_id", None)
        fig_id = getattr(pytest, "fig_id", None)
        if not (page_id and fig_id):
            pytest.skip("fig not ready")
        r = auth.patch(
            f"{BASE}/api/pages/{page_id}/figures/{fig_id}",
            json={"deleted": True},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        # Count remaining non-deleted figs on that page
        after = r.json()
        remaining = [f for f in after.get("figures", []) if not f.get("deleted")]

        with _download_zip(token, doc) as z:
            names = z.namelist()
            img_names = [n for n in names if n.startswith("bilder/") and n.endswith(".jpg")]
            # Expected: zip has len(remaining) image files for this one-page doc
            assert len(img_names) == len(remaining), (
                f"expected {len(remaining)} image(s) in zip after delete, got {img_names}"
            )
        # Restore for next test
        rr = auth.patch(
            f"{BASE}/api/pages/{page_id}/figures/{fig_id}",
            json={"deleted": False},
            timeout=30,
        )
        assert rr.status_code == 200

    def test_06_process_includes_source_figures(self, auth, token, doc):
        """1 real AI call: generated doc stores source_figures and its ZIP
        includes those images."""
        r = auth.post(
            f"{BASE}/api/process",
            json={
                "instruction": "Sammanfatta materialet på svenska i två korta meningar.",
                "document_ids": [doc],
            },
            timeout=30,
        )
        assert r.status_code == 200, r.text
        gen_id = r.json()["id"]
        # Poll
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

        src_figs = final.get("source_figures") or {}
        assert isinstance(src_figs, dict) and len(src_figs) >= 1, (
            f"generated doc missing source_figures, got: {src_figs}"
        )
        # Download generated ZIP and verify images
        r2 = requests.get(
            f"{BASE}/api/documents/{gen_id}/export",
            params={"format": "zip", "token": token},
            timeout=90,
        )
        assert r2.status_code == 200, f"gen zip failed: {r2.status_code} {r2.text[:200]}"
        with zipfile.ZipFile(io.BytesIO(r2.content)) as z:
            names = z.namelist()
            img_names = [n for n in names if n.startswith("bilder/") and n.endswith(".jpg")]
            assert img_names, (
                f"generated-doc ZIP missing bilder/*.jpg - build_files should include "
                f"all source_figures, got: {names}"
            )
            # bildtexter.txt expected too
            assert "bilder/bildtexter.txt" in names
        # Cleanup generated doc
        auth.delete(f"{BASE}/api/documents/{gen_id}", timeout=30)

    def test_07_settings_restored(self, auth):
        MDB.settings.update_one(
            {"id": "global"},
            {"$set": {"speed_mode": "fast", "primary_provider": "gemini"}},
            upsert=True,
        )
        d = auth.get(f"{BASE}/api/settings", timeout=30).json()
        assert d["speed_mode"] == "fast"
        assert d["primary_provider"] == "gemini"
