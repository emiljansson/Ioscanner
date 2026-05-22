"""Email send endpoint tests against commhub.cloud."""
import os
import pytest
from pymongo import MongoClient


@pytest.fixture(scope="module")
def mongo_db():
    client = MongoClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))
    db = client[os.environ.get("DB_NAME", "test_database")]
    yield db
    client.close()


class TestEmailValidation:
    def test_email_empty_to_returns_400(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/email/send",
            json={"to": [], "subject": "TEST: empty", "body_markdown": "**Hi**"},
            timeout=30,
        )
        assert r.status_code == 400, r.text


class TestEmailSend:
    """Real commhub.cloud send — uses Emil@jawel.se only to avoid spamming all four."""

    @pytest.fixture(scope="class")
    def send_response(self, api_client, base_url):
        payload = {
            "to": ["Emil@jawel.se"],
            "subject": "TEST: Jawel Scanner backend smoke",
            "body_markdown": (
                "**Sida 1 – Test**\n"
                "Detta är ett automatiskt testmail från backend-tester.\n"
                "Ignorera detta meddelande.\n\n"
                "**Detaljer**\n"
                "- Skickat via commhub.cloud\n"
                "- Endpoint: /api/email/send\n"
            ),
        }
        r = api_client.post(f"{base_url}/api/email/send", json=payload, timeout=60)
        return r

    def test_send_status_2xx(self, send_response):
        assert send_response.status_code == 200, send_response.text

    def test_send_ok_true(self, send_response):
        data = send_response.json()
        assert data.get("ok") is True, data
        assert 200 <= int(data.get("status_code", 0)) < 300

    def test_email_log_persisted(self, send_response, mongo_db):
        # Locate the most recent log row for Emil@jawel.se and clean it
        doc = mongo_db.email_log.find_one(
            {"to": "Emil@jawel.se", "ok": True},
            sort=[("created_at", -1)],
        )
        assert doc is not None, "email_log row missing for successful send"
        assert "_id" in doc  # only inside mongo, response itself is checked separately
        # cleanup
        mongo_db.email_log.delete_one({"_id": doc["_id"]})

    def test_response_does_not_leak_mongo_id(self, send_response):
        # The HTTP response (top-level keys) should never include mongo's _id.
        # Use JSON parse rather than substring search to avoid false matches
        # such as the legitimate "message_id" field from commhub.
        import json as _json

        def _has_underscore_id(obj):
            if isinstance(obj, dict):
                if "_id" in obj:
                    return True
                return any(_has_underscore_id(v) for v in obj.values())
            if isinstance(obj, list):
                return any(_has_underscore_id(v) for v in obj)
            return False

        data = _json.loads(send_response.text)
        assert not _has_underscore_id(data), data
