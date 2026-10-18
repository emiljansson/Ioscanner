"""Shared pytest fixtures for CopyThat backend tests."""
import io
import os
import pytest
import requests
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
load_dotenv(Path(__file__).resolve().parent.parent.parent / "frontend" / ".env")

BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/").strip('"')
TEST_EMAIL = os.environ.get("TEST_LOGIN_EMAIL", "test@copythat.app")
TEST_CODE = os.environ.get("TEST_LOGIN_CODE", "246810")


@pytest.fixture(scope="session")
def base_url():
    return BASE_URL


@pytest.fixture(scope="session")
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session")
def token(api_client):
    r = api_client.post(f"{BASE_URL}/api/auth/verify", json={"email": TEST_EMAIL, "code": TEST_CODE})
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="session")
def auth_headers(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


@pytest.fixture(scope="session")
def auth_client(token):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    return s


# ---- helpers ----
def make_png_bytes() -> bytes:
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (800, 1000), "white")
    d = ImageDraw.Draw(img)
    d.text((40, 40), "TEST PAGE", fill="black")
    for i in range(10):
        d.text((40, 100 + i * 30), f"Line {i} - svensk text åäö", fill="black")
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def make_pdf_bytes(pages: int = 2) -> bytes:
    import pymupdf
    doc = pymupdf.open()
    for i in range(pages):
        page = doc.new_page(width=595, height=842)
        page.insert_text((72, 72), f"Sida {i + 1} testinnehåll åäö")
    data = doc.tobytes()
    doc.close()
    return data


@pytest.fixture(scope="session")
def png_bytes():
    return make_png_bytes()


@pytest.fixture(scope="session")
def pdf_bytes():
    return make_pdf_bytes(2)
