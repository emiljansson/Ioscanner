"""Health endpoint tests."""
import pytest


# --- Health ---
class TestHealth:
    def test_health_ok(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/health", timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("ok") is True
        assert data.get("llm_key") is True
        assert data.get("commhub") is True

    def test_root(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/", timeout=15)
        assert r.status_code == 200
        assert "Jawel" in r.json().get("message", "")
