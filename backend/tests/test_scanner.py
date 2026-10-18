"""Scanner (NAPS2 'command after scan') endpoint tests."""
import io
import os
import pytest
import requests
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
load_dotenv(Path(__file__).resolve().parent.parent.parent / "frontend" / ".env")

BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/").strip('"')


# ---------------- GET /api/scanner (auth, auto-creates key) ----------------
class TestScannerInfo:
    def test_get_scanner_requires_auth(self):
        r = requests.get(f"{BASE_URL}/api/scanner")
        assert r.status_code == 401

    def test_get_scanner_returns_shape_and_creates_key(self, auth_client):
        r = auth_client.get(f"{BASE_URL}/api/scanner")
        assert r.status_code == 200, r.text
        d = r.json()
        assert set(d.keys()) >= {"key", "course_id", "course_name"}
        assert isinstance(d["key"], str) and len(d["key"]) >= 16
        # Default: no course set -> course_name "Inkorg"
        if d["course_id"] is None:
            assert d["course_name"] == "Inkorg"
        # Second call returns the same key (idempotent)
        r2 = auth_client.get(f"{BASE_URL}/api/scanner")
        assert r2.status_code == 200
        assert r2.json()["key"] == d["key"]


# ---------------- PUT /api/scanner (set folder) ----------------
class TestScannerPut:
    @pytest.fixture(scope="class")
    def test_course(self, auth_client):
        r = auth_client.post(f"{BASE_URL}/api/courses", json={"name": "TEST_Scanner_Folder"})
        assert r.status_code == 200
        cid = r.json()["id"]
        yield cid
        auth_client.delete(f"{BASE_URL}/api/courses/{cid}")

    def test_put_scanner_sets_folder(self, auth_client, test_course):
        r = auth_client.put(f"{BASE_URL}/api/scanner", json={"course_id": test_course})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["course_id"] == test_course
        assert d["course_name"] == "TEST_Scanner_Folder"
        # Verify via GET persistence
        g = auth_client.get(f"{BASE_URL}/api/scanner")
        assert g.json()["course_id"] == test_course

    def test_put_scanner_unknown_course_404(self, auth_client):
        r = auth_client.put(f"{BASE_URL}/api/scanner", json={"course_id": "nonexistent-course-xyz"})
        assert r.status_code == 404


# ---------------- POST /api/scanner/key (regenerate) ----------------
class TestScannerKeyRegen:
    def test_regenerate_key_changes_value(self, auth_client, auth_headers):
        before = auth_client.get(f"{BASE_URL}/api/scanner").json()["key"]
        r = auth_client.post(f"{BASE_URL}/api/scanner/key")
        assert r.status_code == 200
        after = r.json()["key"]
        assert after != before
        assert len(after) >= 16

    def test_old_key_rejected_after_regenerate(self, auth_client):
        """Grab current key, regenerate, then verify old key gets 401 on upload."""
        old = auth_client.get(f"{BASE_URL}/api/scanner").json()["key"]
        auth_client.post(f"{BASE_URL}/api/scanner/key")
        # Build a tiny jpg
        from PIL import Image
        buf = io.BytesIO()
        Image.new("RGB", (50, 50), "white").save(buf, "JPEG")
        files = {"file": ("x.jpg", buf.getvalue(), "image/jpeg")}
        r = requests.post(f"{BASE_URL}/api/scanner/upload",
                          headers={"X-Scan-Key": old}, files=files)
        assert r.status_code == 401, r.text


# ---------------- GET /api/scanner/script ----------------
class TestScannerScript:
    def test_script_download(self, auth_client):
        base = BASE_URL
        r = auth_client.get(f"{BASE_URL}/api/scanner/script", params={"base": base})
        assert r.status_code == 200, r.text
        # Content type
        assert "application/octet-stream" in r.headers.get("content-type", "")
        # Attachment filename
        cd = r.headers.get("content-disposition", "")
        assert "copythat-skanna.cmd" in cd
        body = r.content
        # Must contain the user's key
        key = auth_client.get(f"{BASE_URL}/api/scanner").json()["key"]
        assert key.encode() in body, "script must embed the user's scan key"
        # Must contain the upload URL
        assert f"{base}/api/scanner/upload".encode() in body
        # CRLF line endings
        assert b"\r\n" in body
        # Should NOT contain lone LF (every \n must be preceded by \r)
        text = body.decode("utf-8")
        for i, ch in enumerate(text):
            if ch == "\n":
                assert i > 0 and text[i - 1] == "\r", f"lone LF at pos {i}"

    def test_script_invalid_base_400(self, auth_client):
        r = auth_client.get(f"{BASE_URL}/api/scanner/script", params={"base": "not a url"})
        assert r.status_code == 400

    def test_script_requires_auth(self):
        r = requests.get(f"{BASE_URL}/api/scanner/script", params={"base": BASE_URL})
        assert r.status_code == 401


# ---------------- POST /api/scanner/upload ----------------
class TestScannerUpload:
    @pytest.fixture(scope="class")
    def folder_course(self, auth_client):
        r = auth_client.post(f"{BASE_URL}/api/courses", json={"name": "TEST_Scanner_Upload_Folder"})
        cid = r.json()["id"]
        # Set as scanner folder
        auth_client.put(f"{BASE_URL}/api/scanner", json={"course_id": cid})
        yield cid
        # cleanup: unset by picking any course... actually just delete; backend will no-op reference
        auth_client.delete(f"{BASE_URL}/api/courses/{cid}")

    def _current_key(self, auth_client) -> str:
        return auth_client.get(f"{BASE_URL}/api/scanner").json()["key"]

    def _jpg(self) -> bytes:
        from PIL import Image, ImageDraw
        img = Image.new("RGB", (400, 500), "white")
        d = ImageDraw.Draw(img)
        d.text((40, 40), "SCANNED PAGE åäö", fill="black")
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=85)
        return buf.getvalue()

    def test_upload_wrong_key_401(self):
        files = {"file": ("x.jpg", self._jpg(), "image/jpeg")}
        r = requests.post(f"{BASE_URL}/api/scanner/upload",
                          headers={"X-Scan-Key": "obviously-wrong-key"}, files=files)
        assert r.status_code == 401

    def test_upload_missing_key_401(self):
        files = {"file": ("x.jpg", self._jpg(), "image/jpeg")}
        r = requests.post(f"{BASE_URL}/api/scanner/upload", files=files)
        # Either 401 (no key provided -> empty header) or 422 (missing header). Expect 401 by code.
        assert r.status_code == 401, r.text

    def test_upload_empty_file_400(self, auth_client, folder_course):
        key = self._current_key(auth_client)
        files = {"file": ("empty.jpg", b"", "image/jpeg")}
        r = requests.post(f"{BASE_URL}/api/scanner/upload",
                          headers={"X-Scan-Key": key}, files=files)
        assert r.status_code == 400, r.text

    def test_upload_jpg_creates_new_doc_in_folder(self, auth_client, folder_course):
        key = self._current_key(auth_client)
        files = {"file": ("skanning.jpg", self._jpg(), "image/jpeg")}
        r = requests.post(f"{BASE_URL}/api/scanner/upload",
                          headers={"X-Scan-Key": key}, files=files)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d.get("ok") is True
        assert "document_id" in d
        # Title starts with "Skanning " then date-time
        assert d["title"].startswith("Skanning ")
        assert d.get("pages", 0) >= 1
        # Verify the doc is in the chosen folder
        got = auth_client.get(f"{BASE_URL}/api/documents/{d['document_id']}")
        assert got.status_code == 200
        assert got.json()["course_id"] == folder_course
        assert got.json()["title"].startswith("Skanning ")
        # pages status should be queued/processing/error/done
        pages = got.json().get("pages", [])
        assert pages, "expected at least one page row"
        for p in pages:
            assert p["status"] in ("queued", "processing", "done", "error")
        # cleanup the created doc
        auth_client.delete(f"{BASE_URL}/api/documents/{d['document_id']}")

    def test_upload_pdf_creates_doc(self, auth_client, folder_course, pdf_bytes):
        key = self._current_key(auth_client)
        files = {"file": ("skanning.pdf", pdf_bytes, "application/pdf")}
        r = requests.post(f"{BASE_URL}/api/scanner/upload",
                          headers={"X-Scan-Key": key}, files=files)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["pages"] >= 2
        auth_client.delete(f"{BASE_URL}/api/documents/{d['document_id']}")

    def test_upload_falls_back_to_inkorg_when_no_folder(self, auth_client, pdf_bytes):
        """Clear the scanner folder by setting it to None via direct DB access,
        then upload and verify it lands in 'Inkorg'."""
        import pymongo
        mcli = pymongo.MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]
        me = auth_client.get(f"{BASE_URL}/api/auth/me").json()
        prev = mcli.users.find_one({"id": me["id"]}, {"scan_course_id": 1})
        prev_folder = prev.get("scan_course_id") if prev else None
        mcli.users.update_one({"id": me["id"]}, {"$unset": {"scan_course_id": ""}})
        try:
            key = self._current_key(auth_client)
            info = auth_client.get(f"{BASE_URL}/api/scanner").json()
            assert info["course_id"] is None
            assert info["course_name"] == "Inkorg"
            from PIL import Image
            buf = io.BytesIO()
            Image.new("RGB", (300, 300), "white").save(buf, "JPEG")
            files = {"file": ("inkorg_scan.jpg", buf.getvalue(), "image/jpeg")}
            r = requests.post(f"{BASE_URL}/api/scanner/upload",
                              headers={"X-Scan-Key": key}, files=files)
            assert r.status_code == 200, r.text
            doc_id = r.json()["document_id"]
            got = auth_client.get(f"{BASE_URL}/api/documents/{doc_id}").json()
            # Resolve the folder name
            cid = got["course_id"]
            courses = auth_client.get(f"{BASE_URL}/api/courses").json()
            name = next((c["name"] for c in courses if c["id"] == cid), None)
            assert name == "Inkorg", f"expected Inkorg, got {name}"
            auth_client.delete(f"{BASE_URL}/api/documents/{doc_id}")
        finally:
            if prev_folder:
                mcli.users.update_one({"id": me["id"]}, {"$set": {"scan_course_id": prev_folder}})
