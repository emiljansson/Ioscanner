"""Tests for the new PDF in-app preview export endpoint (iteration 16).

Covers GET /api/documents/{id}/export?format=pdf (new) and regressions on
docx, html, zip for the same document.
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    BASE_URL = "https://smart-doc-scan-6.preview.emergentagent.com"

EMAIL = "test@copythat.app"
CODE = "246810"


@pytest.fixture(scope="module")
def auth_token():
    r = requests.post(f"{BASE_URL}/api/auth/verify",
                      json={"email": EMAIL, "code": CODE}, timeout=20)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def doc(auth_token):
    """Create a course + an empty document (no AI needed)."""
    h = {"Authorization": f"Bearer {auth_token}"}
    c = requests.post(f"{BASE_URL}/api/courses",
                      json={"name": "TEST_pdf_preview"}, headers=h, timeout=20)
    assert c.status_code == 200, c.text
    course_id = c.json()["id"]
    d = requests.post(
        f"{BASE_URL}/api/documents",
        json={"course_id": course_id, "title": "TEST_pdf_doc"},
        headers=h,
        timeout=20,
    )
    assert d.status_code == 200, d.text
    doc_id = d.json()["id"]
    yield {"doc_id": doc_id, "course_id": course_id, "token": auth_token}
    requests.delete(f"{BASE_URL}/api/documents/{doc_id}", headers=h, timeout=30)
    requests.delete(f"{BASE_URL}/api/courses/{course_id}", headers=h, timeout=20)


class TestPdfExport:
    def test_pdf_via_header_token(self, doc):
        r = requests.get(
            f"{BASE_URL}/api/documents/{doc['doc_id']}/export",
            params={"format": "pdf"},
            headers={"Authorization": f"Bearer {doc['token']}"},
            timeout=90,
        )
        assert r.status_code == 200, r.text
        ct = r.headers.get("content-type", "")
        assert "application/pdf" in ct, f"Expected application/pdf, got {ct}"
        # PDF magic
        assert r.content[:4] == b"%PDF", f"Not a PDF: {r.content[:16]!r}"
        # Should have Content-Disposition with .pdf filename
        cd = r.headers.get("content-disposition", "").lower()
        assert ".pdf" in cd, cd

    def test_pdf_via_query_token(self, doc):
        """Export as PDF using ?token=... (used by iframe/webview URL)."""
        r = requests.get(
            f"{BASE_URL}/api/documents/{doc['doc_id']}/export",
            params={"format": "pdf", "token": doc["token"]},
            timeout=90,
        )
        assert r.status_code == 200, r.text
        assert "application/pdf" in r.headers.get("content-type", "")
        assert r.content[:4] == b"%PDF"

    def test_pdf_requires_auth(self, doc):
        r = requests.get(
            f"{BASE_URL}/api/documents/{doc['doc_id']}/export",
            params={"format": "pdf"},
            timeout=30,
        )
        assert r.status_code == 401

    def test_pdf_unknown_doc_404(self, doc):
        r = requests.get(
            f"{BASE_URL}/api/documents/does-not-exist/export",
            params={"format": "pdf"},
            headers={"Authorization": f"Bearer {doc['token']}"},
            timeout=30,
        )
        assert r.status_code == 404


class TestOtherFormatsRegression:
    def test_docx_still_works(self, doc):
        r = requests.get(
            f"{BASE_URL}/api/documents/{doc['doc_id']}/export",
            params={"format": "docx"},
            headers={"Authorization": f"Bearer {doc['token']}"},
            timeout=60,
        )
        assert r.status_code == 200
        assert "wordprocessingml" in r.headers.get("content-type", "")
        assert r.content[:2] == b"PK"

    def test_html_still_works(self, doc):
        r = requests.get(
            f"{BASE_URL}/api/documents/{doc['doc_id']}/export",
            params={"format": "html"},
            headers={"Authorization": f"Bearer {doc['token']}"},
            timeout=60,
        )
        assert r.status_code == 200
        assert "text/html" in r.headers.get("content-type", "")
        assert "<html" in r.text.lower()

    def test_zip_still_works(self, doc):
        r = requests.get(
            f"{BASE_URL}/api/documents/{doc['doc_id']}/export",
            params={"format": "zip"},
            headers={"Authorization": f"Bearer {doc['token']}"},
            timeout=60,
        )
        assert r.status_code == 200
        assert "application/zip" in r.headers.get("content-type", "")
        assert r.content[:2] == b"PK"
