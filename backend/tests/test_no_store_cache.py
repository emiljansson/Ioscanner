"""Verify Cache-Control: no-store is set on /api/* responses (iteration 21)."""
import os
import pytest
import requests

BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/") if "EXPO_PUBLIC_BACKEND_URL" in os.environ else None

# Fall back to frontend/.env read
if not BASE_URL:
    from pathlib import Path
    for line in Path("/app/frontend/.env").read_text().splitlines():
        if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
            BASE_URL = line.split("=", 1)[1].strip().strip('"').rstrip("/")
            break

TEST_EMAIL = "test@copythat.app"
TEST_CODE = "246810"


@pytest.fixture(scope="module")
def token():
    requests.post(f"{BASE_URL}/api/auth/request-code", json={"email": TEST_EMAIL}, timeout=15)
    r = requests.post(f"{BASE_URL}/api/auth/verify", json={"email": TEST_EMAIL, "code": TEST_CODE}, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def course_id(token):
    r = requests.post(f"{BASE_URL}/api/courses", json={"name": "TEST_NoStoreCache"},
                      headers={"Authorization": f"Bearer {token}"}, timeout=15)
    assert r.status_code == 200, r.text
    cid = r.json()["id"]
    yield cid
    requests.delete(f"{BASE_URL}/api/courses/{cid}", headers={"Authorization": f"Bearer {token}"}, timeout=15)


class TestNoStoreCacheHeaders:
    """All /api/* responses should carry Cache-Control: no-store (unless already set)."""

    def test_health_no_store(self):
        r = requests.get(f"{BASE_URL}/api/health", timeout=15)
        assert r.status_code == 200
        cc = r.headers.get("Cache-Control", "")
        assert "no-store" in cc.lower(), f"Expected no-store, got: {cc!r}"

    def test_documents_list_no_store(self, token, course_id):
        r = requests.get(f"{BASE_URL}/api/documents?course_id={course_id}",
                         headers={"Authorization": f"Bearer {token}"}, timeout=15)
        assert r.status_code == 200
        cc = r.headers.get("Cache-Control", "")
        assert "no-store" in cc.lower(), f"Expected no-store, got: {cc!r}"

    def test_courses_list_no_store(self, token):
        r = requests.get(f"{BASE_URL}/api/courses",
                         headers={"Authorization": f"Bearer {token}"}, timeout=15)
        assert r.status_code == 200
        cc = r.headers.get("Cache-Control", "")
        assert "no-store" in cc.lower(), f"Expected no-store, got: {cc!r}"

    def test_auth_me_no_store(self, token):
        r = requests.get(f"{BASE_URL}/api/auth/me",
                         headers={"Authorization": f"Bearer {token}"}, timeout=15)
        assert r.status_code == 200
        cc = r.headers.get("Cache-Control", "")
        assert "no-store" in cc.lower(), f"Expected no-store, got: {cc!r}"


class TestDeleteDocFlow:
    """Full doc create/list/delete flow should reflect deletion in subsequent GET immediately."""

    def test_create_delete_persist(self, token, course_id):
        hdr = {"Authorization": f"Bearer {token}"}
        # Create 2 docs
        r1 = requests.post(f"{BASE_URL}/api/documents",
                           json={"course_id": course_id, "title": "TEST_NoStore_Doc1"},
                           headers=hdr, timeout=15)
        assert r1.status_code == 200, r1.text
        d1 = r1.json()["id"]
        r2 = requests.post(f"{BASE_URL}/api/documents",
                           json={"course_id": course_id, "title": "TEST_NoStore_Doc2"},
                           headers=hdr, timeout=15)
        assert r2.status_code == 200
        d2 = r2.json()["id"]

        # List should contain both
        lst = requests.get(f"{BASE_URL}/api/documents?course_id={course_id}",
                          headers=hdr, timeout=15).json()
        ids = {d["id"] for d in lst}
        assert d1 in ids and d2 in ids

        # Delete d1
        dr = requests.delete(f"{BASE_URL}/api/documents/{d1}", headers=hdr, timeout=15)
        assert dr.status_code == 200

        # GET list again – d1 must be absent (deleting flag filters it)
        lst2 = requests.get(f"{BASE_URL}/api/documents?course_id={course_id}",
                           headers=hdr, timeout=15).json()
        ids2 = {d["id"] for d in lst2}
        assert d1 not in ids2, f"deleted doc {d1} still in list: {ids2}"
        assert d2 in ids2

        # Cleanup d2
        requests.delete(f"{BASE_URL}/api/documents/{d2}", headers=hdr, timeout=15)
