"""Real AI (paid) OCR + settings + rescan + process + export tests.

Keep OCR calls minimal (<10). After the suite, restore settings to
speed_mode=fast + primary_provider=gemini.
"""
import io
import os
import time
import uuid

import pytest
import requests
import pymupdf
import pymongo
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
load_dotenv(Path(__file__).resolve().parent.parent.parent / "frontend" / ".env")

BASE = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/").strip('"')
MDB = pymongo.MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]


# ---------- fixtures ----------
@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{BASE}/api/auth/verify",
                      json={"email": "test@copythat.app", "code": "246810"},
                      timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def auth(token):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def course(auth):
    r = auth.post(f"{BASE}/api/courses", json={"name": "TEST_AI_Course"}, timeout=30)
    assert r.status_code == 200
    cid = r.json()["id"]
    yield cid
    auth.delete(f"{BASE}/api/courses/{cid}", timeout=30)


def _make_pdf_single_page_with_figure() -> bytes:
    """One A4 page with Swedish text + drawn rectangle 'figure' + printed page number '7'."""
    doc = pymupdf.open()
    p = doc.new_page(width=595, height=842)
    # Printed page number top-right
    p.insert_text((520, 40), "7", fontsize=12)
    # Heading + body
    p.insert_text((72, 90), "Kapitel 3 – Krafter och rörelse", fontsize=18)
    body = (
        "Newtons andra lag säger att kraften F är lika med massan m "
        "gånger accelerationen a. Formeln skrivs F = m * a. "
        "Enheten för kraft är newton (N)."
    )
    y = 130
    for chunk in [body[i:i+70] for i in range(0, len(body), 70)]:
        p.insert_text((72, y), chunk, fontsize=12)
        y += 18
    # A drawn figure (rectangle with inside line - looks like a diagram)
    rect = pymupdf.Rect(100, 300, 400, 500)
    p.draw_rect(rect, color=(0, 0, 0), width=1.5)
    p.draw_line(pymupdf.Point(100, 400), pymupdf.Point(400, 400), color=(0, 0, 0), width=1)
    p.insert_text((120, 330), "Figur 3.2: Fri kropps-diagram", fontsize=10)
    p.insert_text((150, 420), "F = m * a", fontsize=14)
    p.insert_text((72, 540), "Där a är accelerationen, m massan.", fontsize=12)
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
                           headers=hdr, data={"index": idx}, files=files, timeout=60)
        assert cr.status_code == 200, cr.text
        off += chunk
        idx += 1
    comp = requests.post(f"{BASE}/api/uploads/{uid}/complete", headers=hdr, timeout=60)
    return comp


def _wait_page_terminal(auth, did, page_index=0, timeout=240):
    """Wait until page[page_index] is done or error, return the page dict."""
    deadline = time.time() + timeout
    page = None
    while time.time() < deadline:
        r = auth.get(f"{BASE}/api/documents/{did}", timeout=30)
        pages = r.json().get("pages", [])
        if len(pages) > page_index:
            page = pages[page_index]
            if page.get("status") in ("done", "error"):
                return page
        time.sleep(3)
    pytest.fail(f"Page {page_index} never finished within {timeout}s. Last: {page}")


# ---------- tests ----------
class TestSettingsKeys:
    def test_settings_has_openai_and_gemini_keys(self, auth):
        r = auth.get(f"{BASE}/api/settings", timeout=30)
        assert r.status_code == 200
        d = r.json()
        provs = {p["id"]: p for p in d["providers"]}
        assert provs["openai"]["has_key"] is True
        assert provs["gemini"]["has_key"] is True
        assert provs["anthropic"]["has_key"] is False
        assert provs["gemini"]["models"]["fast"] == "gemini-3.8-flash"
        assert provs["gemini"]["models"]["balanced"] == "gemini-3.1-pro-preview"
        assert provs["openai"]["models"]["fast"] == "gpt-5.4-mini"
        assert provs["openai"]["models"]["balanced"] == "gpt-5.5"
        assert d["speed_mode"] == "fast"
        assert d["primary_provider"] == "gemini"


class TestOCRFast:
    """Primary = gemini, speed=fast. 1 real AI call."""
    @pytest.fixture(scope="module")
    def doc(self, auth, course):
        r = auth.post(f"{BASE}/api/documents",
                      json={"course_id": course, "title": "TEST_OCR_Fast"}, timeout=30)
        did = r.json()["id"]
        yield did
        auth.delete(f"{BASE}/api/documents/{did}", timeout=30)

    def test_upload_and_ocr_done(self, auth, token, doc):
        # Make sure global settings = fast + gemini
        MDB.settings.update_one({"id": "global"},
                                {"$set": {"speed_mode": "fast", "primary_provider": "gemini"}},
                                upsert=True)
        pdf = _make_pdf_single_page_with_figure()
        r = _upload(auth, token, doc, "test_fast.pdf", pdf)
        assert r.status_code == 200, r.text
        assert r.json()["pages_created"] == 1
        page = _wait_page_terminal(auth, doc, 0, timeout=240)
        assert page["status"] == "done", f"page ended in error: {page.get('error')}"
        assert isinstance(page.get("markdown"), str) and len(page["markdown"]) > 20
        assert isinstance(page.get("confidence"), (int, float)) and page["confidence"] > 0
        # Printed page number '7'
        assert page.get("page_number") == 7, f"expected printed page_number=7, got {page.get('page_number')}"
        # AI metadata
        ai = page.get("ai") or {}
        assert ai.get("provider") == "gemini"
        assert ai.get("mode") == "fast"
        # Figures with CommHub URL
        figs = [f for f in (page.get("figures") or []) if not f.get("deleted")]
        assert len(figs) >= 1, f"expected >=1 figure, got {page.get('figures')}"
        first = figs[0]
        # CommHub uploads are served via CloudFront, so just check it's a valid https url
        assert first.get("url", "").startswith("https://"), f"figure missing CommHub url: {first}"
        assert first.get("file_id"), f"figure missing CommHub file_id: {first}"
        # Save page_id for next class
        pytest.ocr_fast_page_id = page["id"]
        pytest.ocr_fast_doc_id = doc


class TestOCRBalanced:
    """Switch speed_mode=balanced in mongo, upload a new page, verifier should run."""
    @pytest.fixture(scope="class")
    def doc(self, auth, course):
        r = auth.post(f"{BASE}/api/documents",
                      json={"course_id": course, "title": "TEST_OCR_Balanced"}, timeout=30)
        did = r.json()["id"]
        yield did
        auth.delete(f"{BASE}/api/documents/{did}", timeout=30)

    def test_balanced_runs_verifier(self, auth, token, doc):
        try:
            MDB.settings.update_one({"id": "global"},
                                    {"$set": {"speed_mode": "balanced",
                                              "primary_provider": "gemini"}},
                                    upsert=True)
            pdf = _make_pdf_single_page_with_figure()
            r = _upload(auth, token, doc, "test_balanced.pdf", pdf)
            assert r.status_code == 200, r.text
            page = _wait_page_terminal(auth, doc, 0, timeout=300)
            assert page["status"] == "done", f"page ended in error: {page.get('error')}"
            ai = page.get("ai") or {}
            assert ai.get("mode") == "balanced"
            verifiers = ai.get("verifiers") or []
            assert len(verifiers) >= 1, f"balanced should have >=1 verifier, got {verifiers}"
            # In balanced, primary=gemini -> verifier should be openai (anthropic has no key)
            v_providers = {v["provider"] for v in verifiers}
            assert "openai" in v_providers or "gemini" in v_providers
            for v in verifiers:
                if v["provider"] == "openai":
                    assert v.get("ok") is True, f"openai verifier not ok: {v}"
        finally:
            # ALWAYS restore to fast
            MDB.settings.update_one({"id": "global"},
                                    {"$set": {"speed_mode": "fast",
                                              "primary_provider": "gemini"}},
                                    upsert=True)


class TestRescanBest:
    """Rescan a done page -> uses best mode. 1 real AI call (plus verifiers)."""
    def test_rescan_done_goes_best(self, auth):
        page_id = getattr(pytest, "ocr_fast_page_id", None)
        doc_id = getattr(pytest, "ocr_fast_doc_id", None)
        if not page_id:
            pytest.skip("ocr_fast page not available")
        r = auth.post(f"{BASE}/api/pages/{page_id}/rescan", timeout=30)
        assert r.status_code == 200, r.text
        assert r.json().get("ok") is True
        # Wait for done again
        deadline = time.time() + 300
        page = None
        while time.time() < deadline:
            pages = auth.get(f"{BASE}/api/documents/{doc_id}", timeout=30).json().get("pages", [])
            page = next((p for p in pages if p["id"] == page_id), None)
            if page and page.get("status") in ("done", "error"):
                break
            time.sleep(3)
        assert page and page["status"] == "done", f"rescan ended: {page}"
        ai = page.get("ai") or {}
        assert ai.get("mode") == "best", f"expected mode=best after rescan, got {ai.get('mode')}"


class TestProcessAndExport:
    def test_process_generates_swedish_markdown(self, auth, course):
        did = getattr(pytest, "ocr_fast_doc_id", None)
        if not did:
            pytest.skip("fast doc missing")
        r = auth.post(f"{BASE}/api/process",
                      json={"instruction": "Sammanfatta materialet på svenska i tre korta punkter.",
                            "document_ids": [did]}, timeout=30)
        assert r.status_code == 200, r.text
        gen = r.json()
        gen_id = gen["id"]
        assert gen["kind"] == "generated"
        # Wait for AI
        deadline = time.time() + 300
        final = None
        while time.time() < deadline:
            rr = auth.get(f"{BASE}/api/documents/{gen_id}", timeout=30)
            if rr.status_code == 200 and rr.json()["status"] in ("ready", "error"):
                final = rr.json()
                break
            time.sleep(3)
        assert final, "generation timed out"
        assert final["status"] == "ready", f"generation failed: {final}"
        md = final.get("markdown") or ""
        assert len(md) > 20, f"too short: {md}"
        # Expect Swedish-ish content
        pytest.gen_doc_id = gen_id
        pytest.source_doc_id = did

    def test_export_source_docx_and_zip(self, auth, token):
        did = getattr(pytest, "source_doc_id", None)
        if not did:
            pytest.skip("source doc missing")
        for fmt, mime in [("docx", "wordprocessingml"), ("zip", "zip")]:
            r = requests.get(f"{BASE}/api/documents/{did}/export",
                             params={"format": fmt, "token": token}, timeout=60)
            assert r.status_code == 200, f"{fmt}: {r.status_code} {r.text[:200]}"
            assert mime in r.headers.get("content-type", ""), r.headers
            assert len(r.content) > 500

    def test_export_generated_docx_and_zip(self, auth, token):
        gid = getattr(pytest, "gen_doc_id", None)
        if not gid:
            pytest.skip("gen doc missing")
        for fmt, mime in [("docx", "wordprocessingml"), ("zip", "zip")]:
            r = requests.get(f"{BASE}/api/documents/{gid}/export",
                             params={"format": fmt, "token": token}, timeout=60)
            assert r.status_code == 200, f"{fmt}: {r.status_code} {r.text[:200]}"
            assert mime in r.headers.get("content-type", ""), r.headers
            assert len(r.content) > 300
        # Cleanup generated doc
        auth.delete(f"{BASE}/api/documents/{gid}", timeout=30)


class TestRestoreSettings:
    def test_settings_restored_fast_gemini(self, auth):
        MDB.settings.update_one({"id": "global"},
                                {"$set": {"speed_mode": "fast", "primary_provider": "gemini"}},
                                upsert=True)
        r = auth.get(f"{BASE}/api/settings", timeout=30)
        d = r.json()
        assert d["speed_mode"] == "fast"
        assert d["primary_provider"] == "gemini"
