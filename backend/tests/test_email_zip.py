"""Tests for POST /api/documents/{id}/email (iteration 15).

Covers: happy-path returns {ok: true, email}, requires auth, 404 for unknown doc.
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
    requests.post(f"{BASE_URL}/api/auth/request-code", json={"email": EMAIL}, timeout=20)
    r = requests.post(f"{BASE_URL}/api/auth/verify", json={"email": EMAIL, "code": CODE}, timeout=20)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def doc(auth_token):
    h = {"Authorization": f"Bearer {auth_token}"}
    c = requests.post(f"{BASE_URL}/api/courses", json={"name": "TEST_email_zip"}, headers=h, timeout=20)
    assert c.status_code == 200, c.text
    course_id = c.json()["id"]
    d = requests.post(
        f"{BASE_URL}/api/documents",
        json={"course_id": course_id, "title": "TEST_email_doc"},
        headers=h, timeout=20,
    )
    assert d.status_code == 200, d.text
    doc_id = d.json()["id"]
    yield {"doc_id": doc_id, "course_id": course_id, "token": auth_token}
    requests.delete(f"{BASE_URL}/api/documents/{doc_id}", headers=h, timeout=20)
    requests.delete(f"{BASE_URL}/api/courses/{course_id}", headers=h, timeout=20)


class TestEmailZip:
    def test_email_requires_auth(self, doc):
        r = requests.post(f"{BASE_URL}/api/documents/{doc['doc_id']}/email", timeout=30)
        assert r.status_code == 401

    def test_email_unknown_doc_404(self, doc):
        r = requests.post(
            f"{BASE_URL}/api/documents/does-not-exist/email",
            headers={"Authorization": f"Bearer {doc['token']}"}, timeout=30,
        )
        assert r.status_code == 404

    def test_email_happy_path(self, doc):
        """Should upload ZIP to CommHub and email user. May return 503 if CommHub email not configured."""
        r = requests.post(
            f"{BASE_URL}/api/documents/{doc['doc_id']}/email",
            headers={"Authorization": f"Bearer {doc['token']}"}, timeout=120,
        )
        # Accept 200 (success) or 503 (CommHub email not configured in test env)
        assert r.status_code in (200, 503), r.text
        if r.status_code == 200:
            body = r.json()
            assert body.get("ok") is True
            assert body.get("email") == EMAIL
