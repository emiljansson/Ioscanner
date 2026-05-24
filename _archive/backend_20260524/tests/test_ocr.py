"""OCR scan and rescan endpoint tests."""
import os
import pytest
from pymongo import MongoClient


@pytest.fixture(scope="module")
def mongo_db():
    client = MongoClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))
    db = client[os.environ.get("DB_NAME", "test_database")]
    yield db
    client.close()


class TestOCRScan:
    """POST /api/ocr/scan"""

    @pytest.fixture(scope="class")
    def scan_response(self, api_client, base_url, text_image_b64):
        # OCR via dualhead AI – may take up to ~60s
        r = api_client.post(
            f"{base_url}/api/ocr/scan",
            json={"image_base64": text_image_b64},
            timeout=180,
        )
        return r

    def test_scan_status_200(self, scan_response):
        assert scan_response.status_code == 200, scan_response.text

    def test_scan_response_shape(self, scan_response):
        data = scan_response.json()
        for k in ["id", "structured_text", "plain_text", "confidence_percent",
                  "error_estimate_percent", "attempts", "created_at"]:
            assert k in data, f"missing field {k}"
        # No mongo _id leak
        assert "_id" not in data

    def test_scan_attempts_is_one(self, scan_response):
        assert scan_response.json().get("attempts") == 1

    def test_scan_confidence_range(self, scan_response):
        d = scan_response.json()
        assert 0 <= float(d["confidence_percent"]) <= 100
        assert 0 <= float(d["error_estimate_percent"]) <= 100
        # error + confidence should be ~100 (rounded)
        s = float(d["confidence_percent"]) + float(d["error_estimate_percent"])
        assert 99.0 <= s <= 101.0

    def test_scan_has_bold_or_text(self, scan_response):
        d = scan_response.json()
        # structured_text should contain markdown bold for a heading like FAKTURA
        assert len(d["plain_text"]) > 20, f"plain too short: {d['plain_text']!r}"
        # bold marker likely present given the explicit prompt
        assert "**" in d["structured_text"], f"no bold markers in structured: {d['structured_text'][:200]}"

    def test_scan_persisted_in_mongo(self, scan_response, mongo_db):
        sid = scan_response.json()["id"]
        doc = mongo_db.scans.find_one({"id": sid})
        assert doc is not None, "scan not persisted"
        # cleanup
        mongo_db.scans.delete_one({"id": sid})


class TestOCRScanValidation:
    def test_scan_missing_image_returns_400(self, api_client, base_url):
        r = api_client.post(f"{base_url}/api/ocr/scan", json={"image_base64": ""}, timeout=30)
        assert r.status_code == 400, r.text

    def test_scan_missing_field_returns_422(self, api_client, base_url):
        r = api_client.post(f"{base_url}/api/ocr/scan", json={}, timeout=30)
        # pydantic validation -> 422
        assert r.status_code in (400, 422), r.text


class TestOCRRescan:
    """POST /api/ocr/rescan – confidence should not decrease, attempts increments."""

    @pytest.fixture(scope="class")
    def first_scan(self, api_client, base_url, text_image_b64):
        r = api_client.post(
            f"{base_url}/api/ocr/scan",
            json={"image_base64": text_image_b64},
            timeout=180,
        )
        assert r.status_code == 200, r.text
        return r.json()

    @pytest.fixture(scope="class")
    def rescan_response(self, api_client, base_url, text_image_b64, first_scan):
        payload = {
            "image_base64": text_image_b64,
            "previous_text": first_scan["plain_text"],
            "previous_confidence": float(first_scan["confidence_percent"]),
            "attempts": int(first_scan["attempts"]),
        }
        r = api_client.post(f"{base_url}/api/ocr/rescan", json=payload, timeout=180)
        return r

    def test_rescan_status_200(self, rescan_response):
        assert rescan_response.status_code == 200, rescan_response.text

    def test_rescan_attempts_incremented(self, rescan_response, first_scan):
        new_attempts = rescan_response.json().get("attempts")
        assert new_attempts == int(first_scan["attempts"]) + 1, (
            f"expected {first_scan['attempts'] + 1}, got {new_attempts}"
        )

    def test_rescan_confidence_not_lower(self, rescan_response, first_scan):
        new_c = float(rescan_response.json()["confidence_percent"])
        prev_c = float(first_scan["confidence_percent"])
        assert new_c >= prev_c, f"confidence regressed: prev={prev_c}, new={new_c}"

    def test_rescan_persisted(self, rescan_response, mongo_db):
        sid = rescan_response.json()["id"]
        doc = mongo_db.scans.find_one({"id": sid})
        assert doc is not None
        mongo_db.scans.delete_one({"id": sid})
