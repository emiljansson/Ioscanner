"""E2E test for the RECITATION fix: upload 'Sinnesorganen samlar information.pdf'
via /api/scanner/upload and confirm all 6 pages reach status 'done'
(page 5 MUST NOT be in error).

Takes several minutes (real AI).
"""
import os
import time
from pathlib import Path

import pytest
import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
load_dotenv(Path(__file__).resolve().parent.parent.parent / "frontend" / ".env")

BASE = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/").strip('"')
TEST_EMAIL = os.environ.get("TEST_LOGIN_EMAIL", "test@copythat.app")
TEST_CODE = os.environ.get("TEST_LOGIN_CODE", "246810")
PDF_PATH = Path(__file__).resolve().parent / "sinnesorganen.pdf"


@pytest.fixture(scope="module")
def auth():
    r = requests.post(f"{BASE}/api/auth/verify",
                      json={"email": TEST_EMAIL, "code": TEST_CODE}, timeout=30)
    assert r.status_code == 200, r.text
    token = r.json()["token"]
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    yield s


@pytest.fixture(scope="module")
def scan_key(auth):
    r = auth.get(f"{BASE}/api/scanner", timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["key"]


class TestSinnesorganenRecitation:
    """E2E: page 5 of the ear-chapter PDF used to fail with Gemini RECITATION.
    After the fix it must fall back to OpenAI and finish as 'done'."""

    def test_upload_and_all_pages_done(self, auth, scan_key):
        assert PDF_PATH.exists(), f"missing fixture {PDF_PATH}"
        pdf_bytes = PDF_PATH.read_bytes()
        headers = {"X-Scan-Key": scan_key}
        files = {"file": (PDF_PATH.name, pdf_bytes, "application/pdf")}
        r = requests.post(f"{BASE}/api/scanner/upload", headers=headers, files=files, timeout=120)
        assert r.status_code == 200, f"upload failed: {r.status_code} {r.text}"
        j = r.json()
        assert j["ok"] is True
        did = j["document_id"]
        assert j["pages"] == 6, f"expected 6 pages, got {j['pages']}"

        try:
            # Poll up to 10 minutes
            deadline = time.time() + 600
            last = None
            while time.time() < deadline:
                rr = auth.get(f"{BASE}/api/documents/{did}", timeout=30)
                assert rr.status_code == 200, rr.text
                last = rr.json()
                pages = last.get("pages", [])
                statuses = [p.get("status") for p in pages]
                pending = [s for s in statuses if s in ("queued", "processing")]
                if not pending and len(pages) == 6:
                    break
                time.sleep(10)

            pages = last.get("pages", []) if last else []
            assert len(pages) == 6, f"expected 6 pages, got {len(pages)}: {pages}"
            # Sort by page_index for stable reporting
            pages_sorted = sorted(pages, key=lambda p: p.get("index", 0))

            # No page should be in error, especially not page 5
            errors = [(i + 1, p.get("status"), (p.get("error") or "")[:200])
                      for i, p in enumerate(pages_sorted) if p.get("status") != "done"]
            assert not errors, f"pages not done: {errors}"

            # Page 5 (index 4) must mention 'Hörseln' in markdown
            page5 = pages_sorted[4]
            md5 = (page5.get("markdown") or "")
            assert "Hörsel" in md5 or "Hörseln" in md5 or "hörsel" in md5.lower(), \
                f"page 5 markdown missing 'Hörseln': first 400 chars: {md5[:400]!r}"
        finally:
            # Cleanup
            try:
                auth.delete(f"{BASE}/api/documents/{did}", timeout=30)
            except Exception:
                pass
