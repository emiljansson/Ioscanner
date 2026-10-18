"""iteration_8: verify the three HTML/title bugs are fixed.

Covers:
  (1) Scan doc with a seeded page containing <div style="page-break-before: always;">
      -> GET /api/documents/{id}/markdown strips <div>;
      -> export docx has no 'Title' paragraph style AND no '<div'.
  (2) Generated doc via POST /api/process (one real AI call):
      -> markdown has no '<div' AND docx has no Title style.
"""
import io
import os
import re
import time
import uuid
import zipfile
import datetime as dt
from pathlib import Path

import pymongo
import pytest
import requests
from dotenv import load_dotenv

load_dotenv(Path("/app/backend/.env"))
load_dotenv(Path("/app/frontend/.env"))

BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/").strip('"')
MCLI = pymongo.MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]

PAGE_BREAK_MD = (
    '# Rubrik\n\nText\n\n'
    '<div style="page-break-before: always;"></div>\n\n'
    'Mer text'
)


def docx_document_xml(docx_bytes: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(docx_bytes)) as z:
        return z.read("word/document.xml").decode("utf-8")


def assert_no_title_style(xml: str) -> None:
    # pandoc --metadata=title emits a paragraph with pStyle Title and a 'title' class
    assert 'w:val="Title"' not in xml, "docx still contains Title paragraph style"
    assert 'w:val="Subtitle"' not in xml, "docx still contains Subtitle style"


def assert_no_div(text: str) -> None:
    assert "<div" not in text.lower(), f"Found '<div' in output: {text[:400]!r}"


# ---------------- Fixtures ----------------
@pytest.fixture(scope="module")
def course_id(auth_client):
    r = auth_client.post(f"{BASE_URL}/api/courses", json={"name": "TEST_striphtml"})
    assert r.status_code == 200, r.text
    cid = r.json()["id"]
    yield cid
    auth_client.delete(f"{BASE_URL}/api/courses/{cid}")


# ---------------- 1) Scan doc with seeded page-break page ----------------
class TestScanDocStripsDiv:
    @pytest.fixture(scope="class")
    def seeded_doc(self, auth_client, course_id):
        r = auth_client.post(f"{BASE_URL}/api/documents",
                             json={"course_id": course_id, "title": "TEST_pagebreak"})
        did = r.json()["id"]
        user = auth_client.get(f"{BASE_URL}/api/auth/me").json()
        pid = uuid.uuid4().hex
        MCLI.pages.insert_one({
            "id": pid, "user_id": user["id"], "document_id": did, "order": 0,
            "status": "done", "markdown": PAGE_BREAK_MD,
            "figures": [], "page_number": 1, "confidence": 95, "attempts": 1,
            "created_at": dt.datetime.utcnow().isoformat(),
            "updated_at": dt.datetime.utcnow().isoformat(),
        })
        yield did
        MCLI.pages.delete_many({"document_id": did})
        auth_client.delete(f"{BASE_URL}/api/documents/{did}")

    def test_markdown_endpoint_strips_div(self, auth_client, seeded_doc):
        r = auth_client.get(f"{BASE_URL}/api/documents/{seeded_doc}/markdown")
        assert r.status_code == 200, r.text
        data = r.json()
        md = data["markdown"]
        assert_no_div(md)
        # Content preserved
        assert "Rubrik" in md and "Mer text" in md

    def test_docx_export_has_no_title_style_or_div(self, auth_client, token, seeded_doc):
        r = requests.get(f"{BASE_URL}/api/documents/{seeded_doc}/export",
                         params={"format": "docx", "token": token})
        assert r.status_code == 200, r.text[:400]
        assert "wordprocessingml" in r.headers.get("content-type", "")
        xml = docx_document_xml(r.content)
        assert_no_title_style(xml)
        assert_no_div(xml)
        # Heading "Rubrik" is still present as a Heading (not Title)
        assert "Rubrik" in xml

    def test_txt_export_has_no_div(self, auth_client, token, seeded_doc):
        r = requests.get(f"{BASE_URL}/api/documents/{seeded_doc}/export",
                         params={"format": "txt", "token": token})
        assert r.status_code == 200, r.text[:200]
        assert_no_div(r.text)


# ---------------- 2) Generated doc via /process (real AI, 1 call) -------
class TestGeneratedDocNoHtmlNoTitle:
    """Real AI call. The INSTRUCTION_SYSTEM forbids HTML and task titles; verify."""

    @pytest.fixture(scope="class")
    def generated_doc(self, auth_client, course_id):
        # Seed a 'done' page with substantial Swedish text so AI has material
        r = auth_client.post(f"{BASE_URL}/api/documents",
                             json={"course_id": course_id, "title": "TEST_src_for_process"})
        src_did = r.json()["id"]
        user = auth_client.get(f"{BASE_URL}/api/auth/me").json()
        pid = uuid.uuid4().hex
        MCLI.pages.insert_one({
            "id": pid, "user_id": user["id"], "document_id": src_did, "order": 0,
            "status": "done", "markdown": (
                "# Fotosyntesen\n\nFotosyntesen är den process där växter använder "
                "solenergi, vatten och koldioxid för att producera glukos och syre. "
                "Reaktionen sker i kloroplasterna och kan sammanfattas som:\n\n"
                "6 CO2 + 6 H2O -> C6H12O6 + 6 O2\n\n"
                "Processen består av ljusreaktionerna och Calvincykeln."
            ),
            "figures": [], "page_number": 1, "confidence": 95, "attempts": 1,
            "created_at": dt.datetime.utcnow().isoformat(),
            "updated_at": dt.datetime.utcnow().isoformat(),
        })
        # Trigger /process - 1 real AI call
        r = auth_client.post(f"{BASE_URL}/api/process", json={
            "instruction": "Gör en kort sammanfattning i punktform.",
            "document_ids": [src_did],
        })
        assert r.status_code == 200, r.text
        gen_id = r.json()["id"]
        # Poll up to 180 s
        final = None
        deadline = time.time() + 180
        while time.time() < deadline:
            r = auth_client.get(f"{BASE_URL}/api/documents/{gen_id}")
            if r.status_code == 200 and r.json()["status"] in ("ready", "error"):
                final = r.json()
                break
            time.sleep(3)
        yield final, gen_id
        auth_client.delete(f"{BASE_URL}/api/documents/{gen_id}")
        MCLI.pages.delete_many({"document_id": src_did})
        auth_client.delete(f"{BASE_URL}/api/documents/{src_did}")

    def test_generated_markdown_has_no_div(self, generated_doc):
        final, _ = generated_doc
        assert final is not None, "generation never completed"
        assert final["status"] == "ready", f"generation failed: {final.get('error')}"
        md = final.get("markdown") or ""
        assert md.strip(), "generated markdown is empty"
        assert_no_div(md)
        # Also: no obvious HTML tag we strip
        assert not re.search(r"</?(div|span|br|p|hr|center|font)\b", md, re.I), \
            f"HTML tag survived: {md[:300]!r}"

    def test_generated_docx_no_title_style(self, auth_client, token, generated_doc):
        final, gen_id = generated_doc
        if not final or final.get("status") != "ready":
            pytest.skip("generation not ready")
        r = requests.get(f"{BASE_URL}/api/documents/{gen_id}/export",
                         params={"format": "docx", "token": token})
        assert r.status_code == 200, r.text[:400]
        xml = docx_document_xml(r.content)
        assert_no_title_style(xml)
        assert_no_div(xml)
