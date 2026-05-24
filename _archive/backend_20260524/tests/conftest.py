import io
import base64
import os
import pytest
import requests
from PIL import Image, ImageDraw, ImageFont

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL") or "https://smart-doc-scan-6.preview.emergentagent.com"
BASE_URL = BASE_URL.rstrip("/")


@pytest.fixture(scope="session")
def base_url():
    return BASE_URL


@pytest.fixture(scope="session")
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


def _build_text_image_b64() -> str:
    """Build a realistic test document image with a header and a few body lines."""
    W, H = 900, 600
    img = Image.new("RGB", (W, H), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)

    # Try to load a TTF; fall back to default bitmap font
    title_font = None
    body_font = None
    for path in [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]:
        try:
            title_font = ImageFont.truetype(path, 42)
            body_font = ImageFont.truetype(path.replace("Bold", ""), 26)
            break
        except Exception:
            continue
    if title_font is None:
        title_font = ImageFont.load_default()
        body_font = ImageFont.load_default()

    # Header
    draw.text((40, 30), "FAKTURA NR 12345", fill=(0, 0, 0), font=title_font)
    draw.line([(40, 90), (W - 40, 90)], fill=(0, 0, 0), width=2)

    # Body lines (Swedish)
    lines = [
        "Kund: Anna Andersson",
        "Adress: Storgatan 12, 11122 Stockholm",
        "Datum: 2026-01-15",
        "",
        "Beskrivning: Konsulttjanster januari",
        "Antal: 10 timmar",
        "Pris per timme: 950 SEK",
        "Totalt: 9500 SEK",
        "Moms 25%: 2375 SEK",
        "Att betala: 11875 SEK",
    ]
    y = 120
    for line in lines:
        draw.text((40, y), line, fill=(0, 0, 0), font=body_font)
        y += 40

    # Add small visual feature to avoid uniform variance
    draw.rectangle([(W - 200, 30), (W - 40, 90)], outline=(0, 0, 0), width=3)
    draw.text((W - 190, 40), "ORIGINAL", fill=(0, 0, 0), font=body_font)

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii")


@pytest.fixture(scope="session")
def text_image_b64():
    return _build_text_image_b64()
