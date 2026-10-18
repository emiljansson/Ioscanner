"""Tests for the Word in-app preview endpoint (iteration 15).

Covers GET /api/documents/{id}/export?format=html (new), plus docx and zip
to make sure the existing exports are not broken.
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
    r = requests.post(f"{BASE_URL}/api/auth/request-code", json={"email": EMAIL}, timeout=20)
    assert r.status_code == 200, r.text
    r = requests.post(f"{BASE_URL}/api/auth/verify", json={"email": EMAIL, "code": CODE}, timeout=20)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def doc(auth_token):
    """Create a course + an empty document (no AI needed)."""
    h = {"Authorization": f"Bearer {auth_token}"}
    c = requests.post(f"{BASE_URL}/api/courses", json={"name": "TEST_word_preview"}, headers=h, timeout=20)
    assert c.status_code == 200, c.text
    course_id = c.json()["id"]
    d = requests.post(
        f"{BASE_URL}/api/documents",
        json={"course_id": course_id, "title": "TEST_word_doc"},
        headers=h,
        timeout=20,
    )
    assert d.status_code == 200, d.text
    doc_id = d.json()["id"]
    yield {"doc_id": doc_id, "course_id": course_id, "token": auth_token}
    # cleanup
    requests.delete(f"{BASE_URL}/api/documents/{doc_id}", headers=h, timeout=20)
    requests.delete(f"{BASE_URL}/api/courses/{course_id}", headers=h, timeout=20)


class TestHtmlExport:
    def test_html_via_header_token(self, doc):
        """Export as HTML using Authorization header."""
        r = requests.get(
            f"{BASE_URL}/api/documents/{doc['doc_id']}/export",
            params={"format": "html"},
            headers={"Authorization": f"Bearer {doc['token']}"},
            timeout=60,
        )
        assert r.status_code == 200, r.text
        ct = r.headers.get("content-type", "")
        assert "text/html" in ct, f"Expected text/html, got {ct}"
        body = r.text
        # Pandoc standalone HTML + our injected CSS
        assert "<html" in body.lower()
        assert "<style" in body.lower()
        # No file download header
        assert "attachment" not in r.headers.get("content-disposition", "").lower()

    def test_html_via_query_token(self, doc):
        """Export as HTML using ?token=... (used by iframe srcDoc/url)."""
        r = requests.get(
            f"{BASE_URL}/api/documents/{doc['doc_id']}/export",
            params={"format": "html", "token": doc["token"]},
            timeout=60,
        )
        assert r.status_code == 200, r.text
        assert "text/html" in r.headers.get("content-type", "")

    def test_html_requires_auth(self, doc):
        r = requests.get(
            f"{BASE_URL}/api/documents/{doc['doc_id']}/export",
            params={"format": "html"},
            timeout=30,
        )
        assert r.status_code == 401

    def test_html_wrong_user_404(self, doc):
        # Random doc id with valid token -> 404 "Hittades inte"
        r = requests.get(
            f"{BASE_URL}/api/documents/does-not-exist/export",
            params={"format": "html"},
            headers={"Authorization": f"Bearer {doc['token']}"},
            timeout=30,
        )
        assert r.status_code == 404


class TestLegacyExports:
    def test_docx_still_works(self, doc):
        r = requests.get(
            f"{BASE_URL}/api/documents/{doc['doc_id']}/export",
            params={"format": "docx"},
            headers={"Authorization": f"Bearer {doc['token']}"},
            timeout=60,
        )
        assert r.status_code == 200, r.text
        ct = r.headers.get("content-type", "")
        assert "wordprocessingml" in ct, ct
        # DOCX is a ZIP, starts with PK
        assert r.content[:2] == b"PK"
        assert "attachment" in r.headers.get("content-disposition", "").lower()

    def test_zip_still_works(self, doc):
        r = requests.get(
            f"{BASE_URL}/api/documents/{doc['doc_id']}/export",
            params={"format": "zip"},
            headers={"Authorization": f"Bearer {doc['token']}"},
            timeout=60,
        )
        assert r.status_code == 200, r.text
        assert "application/zip" in r.headers.get("content-type", "")
        assert r.content[:2] == b"PK"
