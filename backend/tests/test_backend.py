"""End-to-end backend tests for CopyThat."""
import io
import os
import time
import pytest
import requests

from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
load_dotenv(Path(__file__).resolve().parent.parent.parent / "frontend" / ".env")

BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/").strip('"')


# ---------- Auth ----------
class TestAuth:
    def test_request_code_unknown_email_403(self, api_client):
        r = api_client.post(f"{BASE_URL}/api/auth/request-code",
                            json={"email": "not-invited-random@example.com"})
        assert r.status_code == 403, r.text

    def test_request_code_invalid_format_422(self, api_client):
        r = api_client.post(f"{BASE_URL}/api/auth/request-code", json={"email": "not-an-email"})
        assert r.status_code == 422

    def test_request_code_test_user_ok(self, api_client):
        r = api_client.post(f"{BASE_URL}/api/auth/request-code", json={"email": "test@copythat.app"})
        assert r.status_code == 200
        assert r.json().get("ok") is True

    def test_verify_wrong_code_401(self, api_client):
        r = api_client.post(f"{BASE_URL}/api/auth/verify",
                            json={"email": "test@copythat.app", "code": "000000"})
        assert r.status_code == 401

    def test_verify_ok(self, api_client):
        r = api_client.post(f"{BASE_URL}/api/auth/verify",
                            json={"email": "test@copythat.app", "code": "246810"})
        assert r.status_code == 200
        data = r.json()
        assert "token" in data and "user" in data
        assert data["user"]["email"] == "test@copythat.app"
        assert "_id" not in data["user"]

    def test_auth_me(self, auth_client):
        r = auth_client.get(f"{BASE_URL}/api/auth/me")
        assert r.status_code == 200
        assert r.json()["email"] == "test@copythat.app"
        assert "_id" not in r.json()

    def test_auth_me_no_token_401(self, api_client):
        s = requests.Session()
        r = s.get(f"{BASE_URL}/api/auth/me")
        assert r.status_code == 401

    def test_request_code_owner_commhub_public_api_disabled_503(self, api_client):
        """Regression: owner emil@jawel.se with CommHub Public API disabled must
        return 503 (not 502) with Swedish message mentioning Public API."""
        r = api_client.post(f"{BASE_URL}/api/auth/request-code",
                            json={"email": "emil@jawel.se"})
        assert r.status_code == 503, r.text
        detail = r.json().get("detail", "")
        assert "Public API" in detail
        # Must be Swedish, not English
        assert "aktiverad" in detail or "Ägaren" in detail


# ---------- Settings & admin (member perspective) ----------
class TestSettingsAndAdmin:
    def test_settings_get_as_member(self, auth_client):
        r = auth_client.get(f"{BASE_URL}/api/settings")
        assert r.status_code == 200
        d = r.json()
        assert d["speed_mode"] in ("fast", "balanced", "best")
        assert d["is_owner"] is False
        provs = {p["id"]: p for p in d["providers"]}
        assert set(provs) >= {"openai", "gemini", "anthropic"}
        for p in d["providers"]:
            assert "has_key" in p and "models" in p
            assert p["has_key"] is False  # No AI keys configured

    def test_settings_put_as_member_forbidden(self, auth_client):
        r = auth_client.put(f"{BASE_URL}/api/settings", json={"speed_mode": "best"})
        assert r.status_code == 403

    def test_admin_users_list_forbidden(self, auth_client):
        r = auth_client.get(f"{BASE_URL}/api/admin/users")
        assert r.status_code == 403

    def test_admin_users_invite_forbidden(self, auth_client):
        r = auth_client.post(f"{BASE_URL}/api/admin/users", json={"email": "x@y.com"})
        assert r.status_code == 403


# ---------- Courses / documents / inbox ----------
@pytest.fixture(scope="class")
def course_id(auth_client):
    r = auth_client.post(f"{BASE_URL}/api/courses", json={"name": "TEST_Kurs_Pytest"})
    assert r.status_code == 200, r.text
    cid = r.json()["id"]
    yield cid
    auth_client.delete(f"{BASE_URL}/api/courses/{cid}")


class TestCourses:
    def test_create_and_list_course(self, auth_client, course_id):
        r = auth_client.get(f"{BASE_URL}/api/courses")
        assert r.status_code == 200
        ids = {c["id"] for c in r.json()}
        assert course_id in ids
        for c in r.json():
            assert "_id" not in c
            assert "document_count" in c

    def test_rename_course(self, auth_client, course_id):
        r = auth_client.patch(f"{BASE_URL}/api/courses/{course_id}",
                              json={"name": "TEST_Kurs_Pytest_ren"})
        assert r.status_code == 200
        assert r.json()["name"] == "TEST_Kurs_Pytest_ren"

    def test_inbox_creates_default(self, auth_client):
        r = auth_client.post(f"{BASE_URL}/api/inbox")
        assert r.status_code == 200
        d = r.json()
        assert d["course"]["name"] == "Inkorg"
        assert d["document"]["title"].startswith("Mobilscanningar ")
        # idempotent
        r2 = auth_client.post(f"{BASE_URL}/api/inbox")
        assert r2.json()["document"]["id"] == d["document"]["id"]


@pytest.fixture(scope="class")
def document_id(auth_client, course_id):
    r = auth_client.post(f"{BASE_URL}/api/documents",
                         json={"course_id": course_id, "title": "TEST_Doc"})
    assert r.status_code == 200, r.text
    did = r.json()["id"]
    yield did
    auth_client.delete(f"{BASE_URL}/api/documents/{did}")


class TestDocuments:
    def test_get_document_empty(self, auth_client, document_id):
        r = auth_client.get(f"{BASE_URL}/api/documents/{document_id}")
        assert r.status_code == 200
        d = r.json()
        assert d["title"] == "TEST_Doc"
        assert d["pages"] == []

    def test_patch_title(self, auth_client, document_id):
        r = auth_client.patch(f"{BASE_URL}/api/documents/{document_id}",
                              json={"title": "TEST_Doc_2"})
        assert r.status_code == 200
        assert r.json()["title"] == "TEST_Doc_2"

    def test_other_user_isolation(self, auth_client):
        # fetch unknown id => 404
        r = auth_client.get(f"{BASE_URL}/api/documents/nonexistent-id-xyz")
        assert r.status_code == 404
        r = auth_client.get(f"{BASE_URL}/api/courses/nonexistent-id-xyz")
        # courses GET returns list, but PATCH/DELETE should 404
        r = auth_client.patch(f"{BASE_URL}/api/courses/nonexistent-id-xyz", json={"name": "x"})
        assert r.status_code == 404


# ---------- Uploads ----------
class TestUploads:
    @pytest.fixture(scope="class")
    def doc_for_upload(self, auth_client, course_id):
        r = auth_client.post(f"{BASE_URL}/api/documents",
                             json={"course_id": course_id, "title": "TEST_Upload_Doc"})
        did = r.json()["id"]
        yield did
        auth_client.delete(f"{BASE_URL}/api/documents/{did}")

    def _upload(self, auth_headers, doc_id, filename, data):
        s = requests.Session()
        s.headers.update(auth_headers)
        r = s.post(f"{BASE_URL}/api/uploads/init",
                   json={"document_id": doc_id, "filename": filename, "size": len(data)})
        assert r.status_code == 200, r.text
        upload_id = r.json()["upload_id"]
        chunk_size = r.json()["chunk_size"]
        # chunk
        offset = 0
        idx = 0
        headers = {"Authorization": auth_headers["Authorization"]}
        while offset < len(data):
            part = data[offset:offset + chunk_size]
            files = {"file": (f"chunk{idx}", part, "application/octet-stream")}
            cr = requests.post(f"{BASE_URL}/api/uploads/{upload_id}/chunk",
                               headers=headers, data={"index": idx}, files=files)
            assert cr.status_code == 200, cr.text
            offset += chunk_size
            idx += 1
        comp = requests.post(f"{BASE_URL}/api/uploads/{upload_id}/complete", headers=headers)
        return comp

    def test_upload_png(self, auth_headers, doc_for_upload, png_bytes):
        r = self._upload(auth_headers, doc_for_upload, "test.png", png_bytes)
        assert r.status_code == 200, r.text
        assert r.json()["pages_created"] == 1

    def test_upload_pdf_2pages(self, auth_headers, doc_for_upload, pdf_bytes):
        r = self._upload(auth_headers, doc_for_upload, "test.pdf", pdf_bytes)
        assert r.status_code == 200, r.text
        assert r.json()["pages_created"] == 2

    def test_upload_invalid_format_422(self, auth_headers, doc_for_upload):
        r = self._upload(auth_headers, doc_for_upload, "weird.xyz", b"not an image or pdf data")
        # garbage bytes -> 422 (ValueError in pipeline)
        assert r.status_code == 422, r.text

    def test_pages_eventually_get_status(self, auth_client, doc_for_upload):
        # Wait a bit for background OCR to flip pages to error (no AI keys)
        deadline = time.time() + 30
        pages = []
        while time.time() < deadline:
            r = auth_client.get(f"{BASE_URL}/api/documents/{doc_for_upload}")
            pages = r.json().get("pages", [])
            if pages and all(p["status"] in ("done", "error") for p in pages):
                break
            time.sleep(2)
        assert pages, "no pages found after upload"
        # Expected: all end with error "AI-nyckel saknas"
        for p in pages:
            assert p["status"] in ("done", "error", "queued", "processing")


# ---------- Pages ----------
class TestPages:
    @pytest.fixture(scope="class")
    def page_fixture(self, auth_client, auth_headers, course_id, png_bytes):
        r = auth_client.post(f"{BASE_URL}/api/documents",
                             json={"course_id": course_id, "title": "TEST_Pages_Doc"})
        did = r.json()["id"]
        # upload
        s = requests.Session()
        s.headers.update(auth_headers)
        init = s.post(f"{BASE_URL}/api/uploads/init",
                      json={"document_id": did, "filename": "p.png", "size": len(png_bytes)}).json()
        upload_id = init["upload_id"]
        headers = {"Authorization": auth_headers["Authorization"]}
        files = {"file": ("c0", png_bytes, "application/octet-stream")}
        requests.post(f"{BASE_URL}/api/uploads/{upload_id}/chunk",
                      headers=headers, data={"index": 0}, files=files)
        requests.post(f"{BASE_URL}/api/uploads/{upload_id}/complete", headers=headers)
        # wait for page row
        page = None
        deadline = time.time() + 20
        while time.time() < deadline:
            r = auth_client.get(f"{BASE_URL}/api/documents/{did}")
            pages = r.json().get("pages", [])
            if pages:
                page = pages[0]
                break
            time.sleep(1)
        assert page, "page was not created"
        yield page, did
        auth_client.delete(f"{BASE_URL}/api/documents/{did}")

    def test_patch_page_markdown(self, auth_client, page_fixture):
        page, _did = page_fixture
        r = auth_client.patch(f"{BASE_URL}/api/pages/{page['id']}",
                              json={"markdown": "Hej **värld**"})
        assert r.status_code == 200
        data = r.json()
        assert data["markdown"] == "Hej **värld**"
        assert data.get("edited") is True

    def test_add_figure_and_toggle(self, auth_client, page_fixture):
        page, did = page_fixture
        # Wait for page to be ready (not processing) so image is accessible
        for _ in range(10):
            r = auth_client.get(f"{BASE_URL}/api/documents/{did}")
            cur = next((p for p in r.json()["pages"] if p["id"] == page["id"]), {})
            if cur.get("status") in ("done", "error"):
                break
            time.sleep(1)
        r = auth_client.post(f"{BASE_URL}/api/pages/{page['id']}/figures",
                             json={"box_2d": [100, 100, 600, 600], "caption": "fig"})
        assert r.status_code == 200, r.text
        figs = r.json().get("figures", [])
        assert len(figs) == 1
        fig_id = figs[0]["id"]
        # Toggle delete
        r = auth_client.patch(f"{BASE_URL}/api/pages/{page['id']}/figures/{fig_id}",
                              json={"deleted": True})
        assert r.status_code == 200
        toggled = next(f for f in r.json()["figures"] if f["id"] == fig_id)
        assert toggled["deleted"] is True
        # Recrop
        r = auth_client.patch(f"{BASE_URL}/api/pages/{page['id']}/figures/{fig_id}",
                              json={"box_2d": [50, 50, 500, 500]})
        assert r.status_code == 200

    def test_rescan(self, auth_client, page_fixture):
        page, did = page_fixture
        # ensure page is finished before rescan
        for _ in range(20):
            r = auth_client.get(f"{BASE_URL}/api/documents/{did}")
            cur = next((p for p in r.json()["pages"] if p["id"] == page["id"]), {})
            if cur.get("status") in ("done", "error"):
                break
            time.sleep(1)
        r = auth_client.post(f"{BASE_URL}/api/pages/{page['id']}/rescan")
        assert r.status_code == 200
        assert r.json().get("ok") is True

    def test_reorder_and_sort(self, auth_client, auth_headers, course_id, png_bytes):
        # Create a doc with 2 pages
        r = auth_client.post(f"{BASE_URL}/api/documents",
                             json={"course_id": course_id, "title": "TEST_Reorder"})
        did = r.json()["id"]
        s = requests.Session()
        s.headers.update(auth_headers)
        for i in range(2):
            init = s.post(f"{BASE_URL}/api/uploads/init",
                          json={"document_id": did, "filename": f"p{i}.png",
                                "size": len(png_bytes)}).json()
            uid = init["upload_id"]
            headers = {"Authorization": auth_headers["Authorization"]}
            files = {"file": ("c0", png_bytes, "application/octet-stream")}
            requests.post(f"{BASE_URL}/api/uploads/{uid}/chunk",
                          headers=headers, data={"index": 0}, files=files)
            requests.post(f"{BASE_URL}/api/uploads/{uid}/complete", headers=headers)
        # wait
        pages = []
        deadline = time.time() + 20
        while time.time() < deadline:
            pages = auth_client.get(f"{BASE_URL}/api/documents/{did}").json().get("pages", [])
            if len(pages) >= 2:
                break
            time.sleep(1)
        assert len(pages) >= 2
        ids = [p["id"] for p in pages]
        rev = list(reversed(ids))
        r = auth_client.post(f"{BASE_URL}/api/documents/{did}/reorder",
                             json={"page_ids": rev})
        assert r.status_code == 200
        new_ids = [p["id"] for p in r.json()["pages"]]
        assert new_ids == rev
        # Sort endpoint
        r = auth_client.post(f"{BASE_URL}/api/documents/{did}/sort")
        assert r.status_code == 200
        auth_client.delete(f"{BASE_URL}/api/documents/{did}")

    def test_delete_page(self, auth_client, auth_headers, course_id, png_bytes):
        r = auth_client.post(f"{BASE_URL}/api/documents",
                             json={"course_id": course_id, "title": "TEST_Del_Page"})
        did = r.json()["id"]
        s = requests.Session()
        s.headers.update(auth_headers)
        init = s.post(f"{BASE_URL}/api/uploads/init",
                      json={"document_id": did, "filename": "p.png",
                            "size": len(png_bytes)}).json()
        uid = init["upload_id"]
        headers = {"Authorization": auth_headers["Authorization"]}
        requests.post(f"{BASE_URL}/api/uploads/{uid}/chunk",
                      headers=headers, data={"index": 0},
                      files={"file": ("c0", png_bytes, "application/octet-stream")})
        requests.post(f"{BASE_URL}/api/uploads/{uid}/complete", headers=headers)
        pages = []
        deadline = time.time() + 15
        while time.time() < deadline:
            pages = auth_client.get(f"{BASE_URL}/api/documents/{did}").json().get("pages", [])
            if pages:
                break
            time.sleep(1)
        assert pages
        pid = pages[0]["id"]
        r = auth_client.delete(f"{BASE_URL}/api/pages/{pid}")
        assert r.status_code == 200
        pages_after = auth_client.get(f"{BASE_URL}/api/documents/{did}").json().get("pages", [])
        assert all(p["id"] != pid for p in pages_after)
        auth_client.delete(f"{BASE_URL}/api/documents/{did}")


# ---------- Templates ----------
class TestTemplates:
    def test_list_seeds_four(self, auth_client):
        r = auth_client.get(f"{BASE_URL}/api/templates")
        assert r.status_code == 200
        tpls = r.json()
        assert len(tpls) >= 4
        names = {t["name"] for t in tpls}
        for expected in ("Sammanfattning", "Instuderingsfrågor", "Begreppslista", "Förenkla"):
            assert expected in names

    def test_create_and_delete(self, auth_client):
        r = auth_client.post(f"{BASE_URL}/api/templates",
                             json={"name": "TEST_tpl", "instruction": "do something please"})
        assert r.status_code == 200
        tid = r.json()["id"]
        r = auth_client.delete(f"{BASE_URL}/api/templates/{tid}")
        assert r.status_code == 200
        tpls = auth_client.get(f"{BASE_URL}/api/templates").json()
        assert all(t["id"] != tid for t in tpls)


# ---------- Search ----------
class TestSearch:
    def test_search_by_title(self, auth_client, course_id):
        r = auth_client.post(f"{BASE_URL}/api/documents",
                             json={"course_id": course_id, "title": "TEST_SearchableTitle_XYZZY"})
        did = r.json()["id"]
        try:
            r = auth_client.get(f"{BASE_URL}/api/search", params={"q": "XYZZY"})
            assert r.status_code == 200
            hits = r.json()
            assert any(h["document_id"] == did for h in hits)
        finally:
            auth_client.delete(f"{BASE_URL}/api/documents/{did}")

    def test_search_too_short(self, auth_client):
        r = auth_client.get(f"{BASE_URL}/api/search", params={"q": "a"})
        assert r.status_code == 200
        assert r.json() == []


# ---------- Process (generated docs) ----------
class TestProcess:
    def test_process_empty_material_422(self, auth_client, course_id):
        # new empty doc -> no done pages -> material empty
        r = auth_client.post(f"{BASE_URL}/api/documents",
                             json={"course_id": course_id, "title": "TEST_ProcessEmpty"})
        did = r.json()["id"]
        try:
            r = auth_client.post(f"{BASE_URL}/api/process",
                                 json={"instruction": "Sammanfatta detta", "document_ids": [did]})
            assert r.status_code == 422
        finally:
            auth_client.delete(f"{BASE_URL}/api/documents/{did}")

    def test_process_with_seeded_markdown(self, auth_client, course_id):
        # Seed a page with status done + markdown directly in mongo via a direct path:
        # Use the PATCH /api/pages which just sets markdown; need status done. We cannot
        # set status via API, so insert a page then flip status via mongo isn't allowed here.
        # Instead, seed by using mongodb client.
        import pymongo
        from pathlib import Path
        from dotenv import load_dotenv
        load_dotenv(Path("/app/backend/.env"))
        import os
        mcli = pymongo.MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]
        # create document
        r = auth_client.post(f"{BASE_URL}/api/documents",
                             json={"course_id": course_id, "title": "TEST_ProcessOK"})
        did = r.json()["id"]
        # seed a done page
        import uuid, datetime as dt
        pid = uuid.uuid4().hex
        user = auth_client.get(f"{BASE_URL}/api/auth/me").json()
        mcli.pages.insert_one({
            "id": pid, "user_id": user["id"], "document_id": did, "order": 0,
            "status": "done", "markdown": "Detta är ett testinnehåll.",
            "figures": [], "page_number": 1, "confidence": 90,
            "attempts": 1, "created_at": dt.datetime.utcnow().isoformat(),
            "updated_at": dt.datetime.utcnow().isoformat(),
        })
        try:
            r = auth_client.post(f"{BASE_URL}/api/process",
                                 json={"instruction": "Sammanfatta materialet",
                                       "document_ids": [did]})
            assert r.status_code == 200, r.text
            gen = r.json()
            assert gen["kind"] == "generated"
            assert gen["status"] == "processing"
            gen_id = gen["id"]
            # wait for background to flip to error (no AI key)
            final = None
            deadline = time.time() + 25
            while time.time() < deadline:
                r = auth_client.get(f"{BASE_URL}/api/documents/{gen_id}")
                if r.status_code == 200 and r.json()["status"] in ("ready", "error"):
                    final = r.json()
                    break
                time.sleep(2)
            assert final is not None, "generation never completed"
            assert final["status"] == "error"  # No AI keys -> expected error
            auth_client.delete(f"{BASE_URL}/api/documents/{gen_id}")
        finally:
            mcli.pages.delete_many({"document_id": did})
            auth_client.delete(f"{BASE_URL}/api/documents/{did}")


# ---------- Export ----------
class TestExport:
    def test_export_requires_token_query(self, auth_client, token, course_id):
        import pymongo, uuid, datetime as dt
        from pathlib import Path
        from dotenv import load_dotenv
        load_dotenv(Path("/app/backend/.env"))
        mcli = pymongo.MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]
        r = auth_client.post(f"{BASE_URL}/api/documents",
                             json={"course_id": course_id, "title": "TEST_Export"})
        did = r.json()["id"]
        user = auth_client.get(f"{BASE_URL}/api/auth/me").json()
        pid = uuid.uuid4().hex
        mcli.pages.insert_one({
            "id": pid, "user_id": user["id"], "document_id": did, "order": 0,
            "status": "done", "markdown": "# Rubrik\n\nStycke med **fetstil**.",
            "figures": [], "page_number": 1, "confidence": 90, "attempts": 1,
            "created_at": dt.datetime.utcnow().isoformat(),
            "updated_at": dt.datetime.utcnow().isoformat(),
        })
        try:
            for fmt, mime, minsize in [("docx", "wordprocessingml", 500), ("zip", "zip", 500), ("txt", "text/plain", 10)]:
                r = requests.get(f"{BASE_URL}/api/documents/{did}/export",
                                 params={"format": fmt, "token": token})
                assert r.status_code == 200, f"{fmt}: {r.status_code} {r.text[:200]}"
                assert mime in r.headers.get("content-type", ""), r.headers
                assert len(r.content) > minsize, f"{fmt} content too small: {len(r.content)}"
        finally:
            mcli.pages.delete_many({"document_id": did})
            auth_client.delete(f"{BASE_URL}/api/documents/{did}")

    def test_export_no_auth_401(self):
        r = requests.get(f"{BASE_URL}/api/documents/nonexistent/export", params={"format": "docx"})
        assert r.status_code == 401
