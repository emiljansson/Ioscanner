"""Tests for /app/backend/core.py env-var validation and smoke endpoints.

Covers the Railway fix:
  * REQUIRED_ENV list -> single Swedish RuntimeError listing all missing vars.
  * _env() strips surrounding quotes/whitespace.
  * MONGO_URL invalid -> Swedish RuntimeError with masked password.

Also smoke-tests the live backend in this preview to confirm it still boots and the
critical endpoints work.
"""
import os
import sys
import json
import subprocess
import textwrap

import pytest
import requests

BACKEND_DIR = "/app/backend"
BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/").strip('"')
TEST_EMAIL = os.environ.get("TEST_LOGIN_EMAIL", "test@copythat.app")
TEST_CODE = os.environ.get("TEST_LOGIN_CODE", "246810")


# ------------------------------------------------------------------
# Helper: run an isolated python subprocess with a cleaned env, and
# monkeypatch dotenv.load_dotenv to a no-op BEFORE importing core, so
# backend/.env cannot leak in. Prints a JSON blob with the result.
# ------------------------------------------------------------------
def _run_core_import(env: dict) -> dict:
    """Run `import backend.core` in a fully isolated subprocess.

    Returns {"ok": bool, "error_type": str, "error_msg": str, "values": {...}}
    """
    runner = textwrap.dedent(
        """
        import json, sys, os
        # Neutralise dotenv so backend/.env cannot leak into this clean env.
        import dotenv
        dotenv.load_dotenv = lambda *a, **k: False
        dotenv.main.load_dotenv = lambda *a, **k: False
        sys.path.insert(0, "/app")
        sys.path.insert(0, "/app/backend")
        out = {"ok": False, "error_type": None, "error_msg": None, "values": {}}
        try:
            import core  # /app/backend/core.py
            out["ok"] = True
            out["values"] = {
                "COMMHUB_APP_ID": core.COMMHUB_APP_ID,
                "COMMHUB_API_KEY": core.COMMHUB_API_KEY,
                "JWT_SECRET": core.JWT_SECRET,
                "DB_NAME": core.db.name,
            }
        except BaseException as e:
            out["error_type"] = type(e).__name__
            out["error_msg"] = str(e)
        print("===RESULT===")
        print(json.dumps(out))
        """
    )
    # env -i style: start from a truly empty environment, then add caller's keys.
    clean_env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "PYTHONDONTWRITEBYTECODE": "1",
        # Deliberately NO HOME/MONGO_URL/etc unless provided below.
        **env,
    }
    # cwd=/tmp to be extra safe - we're not inside /app/backend so even a bare
    # load_dotenv() with no path would miss backend/.env (the monkeypatch is the
    # real guard, this is belt-and-braces).
    proc = subprocess.run(
        [sys.executable, "-c", runner],
        env=clean_env,
        cwd="/tmp",
        capture_output=True,
        text=True,
        timeout=30,
    )
    stdout = proc.stdout
    marker = "===RESULT==="
    assert marker in stdout, f"runner produced no result\nSTDOUT:\n{stdout}\nSTDERR:\n{proc.stderr}"
    payload = stdout.split(marker, 1)[1].strip().splitlines()[-1]
    return json.loads(payload)


# ================================================================
# 1) Smoke: preview backend still boots and critical endpoints work
# ================================================================
class TestLiveBackendSmoke:
    def test_health(self):
        r = requests.get(f"{BASE_URL}/api/health", timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        # Accept either {status:"ok"} or similar shape.
        assert isinstance(body, dict)
        assert any(str(v).lower() in {"ok", "healthy", "true"} for v in body.values()) or body, body

    def test_request_code_and_verify(self):
        r = requests.post(
            f"{BASE_URL}/api/auth/request-code",
            json={"email": TEST_EMAIL},
            timeout=15,
        )
        assert r.status_code == 200, f"request-code failed: {r.status_code} {r.text}"
        r2 = requests.post(
            f"{BASE_URL}/api/auth/verify",
            json={"email": TEST_EMAIL, "code": TEST_CODE},
            timeout=15,
        )
        assert r2.status_code == 200, f"verify failed: {r2.status_code} {r2.text}"
        data = r2.json()
        assert "token" in data and isinstance(data["token"], str) and len(data["token"]) > 20
        # stash for other tests via class attr
        type(self).token = data["token"]

    def test_settings_authed(self):
        token = getattr(type(self), "token", None)
        if not token:
            # independent login if run in isolation
            r = requests.post(
                f"{BASE_URL}/api/auth/verify",
                json={"email": TEST_EMAIL, "code": TEST_CODE},
                timeout=15,
            )
            assert r.status_code == 200, r.text
            token = r.json()["token"]
        r = requests.get(
            f"{BASE_URL}/api/settings",
            headers={"Authorization": f"Bearer {token}"},
            timeout=15,
        )
        assert r.status_code == 200, f"GET /api/settings: {r.status_code} {r.text}"
        assert isinstance(r.json(), dict)

    def test_courses_authed(self):
        r = requests.post(
            f"{BASE_URL}/api/auth/verify",
            json={"email": TEST_EMAIL, "code": TEST_CODE},
            timeout=15,
        )
        assert r.status_code == 200
        token = r.json()["token"]
        r2 = requests.get(
            f"{BASE_URL}/api/courses",
            headers={"Authorization": f"Bearer {token}"},
            timeout=15,
        )
        assert r2.status_code == 200, f"GET /api/courses: {r2.status_code} {r2.text}"
        assert isinstance(r2.json(), list)


# ================================================================
# 2) Missing vars -> single Swedish RuntimeError listing all missing
# ================================================================
class TestMissingEnvVars:
    def test_only_mongo_url_set_lists_other_four(self):
        res = _run_core_import({"MONGO_URL": "mongodb://localhost:27017"})
        assert res["ok"] is False, f"expected failure, got success: {res}"
        assert res["error_type"] == "RuntimeError", res
        msg = res["error_msg"]
        assert msg.startswith("Miljövariabler saknas:"), f"wrong prefix: {msg!r}"
        for key in ("DB_NAME", "COMMHUB_APP_ID", "COMMHUB_API_KEY", "JWT_SECRET"):
            assert key in msg, f"missing key {key} in message: {msg!r}"
        assert "MONGO_URL" not in msg, f"MONGO_URL should NOT be listed as missing: {msg!r}"
        # Swedish helper text present
        assert "Railway" in msg or "Variables" in msg or "Lägg in" in msg, msg

    def test_all_missing_lists_all_five(self):
        res = _run_core_import({})
        assert res["ok"] is False
        assert res["error_type"] == "RuntimeError"
        for key in ("MONGO_URL", "DB_NAME", "COMMHUB_APP_ID", "COMMHUB_API_KEY", "JWT_SECRET"):
            assert key in res["error_msg"], res["error_msg"]

    def test_whitespace_only_counts_as_missing(self):
        res = _run_core_import({
            "MONGO_URL": "   ",
            "DB_NAME": '""',          # empty-inside-quotes should be considered missing
            "COMMHUB_APP_ID": "'  '",
            "COMMHUB_API_KEY": "",
            "JWT_SECRET": " \t ",
        })
        assert res["ok"] is False, res
        assert res["error_type"] == "RuntimeError"
        for key in ("MONGO_URL", "DB_NAME", "COMMHUB_APP_ID", "COMMHUB_API_KEY", "JWT_SECRET"):
            assert key in res["error_msg"], res["error_msg"]


# ================================================================
# 3) Values wrapped in double quotes -> import succeeds, quotes stripped
# ================================================================
class TestQuoteStripping:
    def test_all_vars_quoted_values_stripped(self):
        res = _run_core_import({
            "MONGO_URL": '"mongodb://localhost:27017"',
            "DB_NAME": '"copythat"',
            "COMMHUB_APP_ID": '"my-app-id"',
            "COMMHUB_API_KEY": '"my-api-key"',
            "JWT_SECRET": '"super-secret"',
        })
        assert res["ok"] is True, f"import failed: {res}"
        v = res["values"]
        assert v["COMMHUB_APP_ID"] == "my-app-id", v
        assert v["COMMHUB_API_KEY"] == "my-api-key", v
        assert v["JWT_SECRET"] == "super-secret", v
        assert v["DB_NAME"] == "copythat", v
        # make sure no stray quotes/whitespace left anywhere
        for key, val in v.items():
            assert '"' not in val, f"stray double-quote in {key}: {val!r}"
            assert "'" not in val, f"stray single-quote in {key}: {val!r}"
            assert val == val.strip(), f"stray whitespace in {key}: {val!r}"

    def test_single_quotes_and_whitespace_also_stripped(self):
        res = _run_core_import({
            "MONGO_URL": "  'mongodb://localhost:27017'  ",
            "DB_NAME": "  copythat  ",
            "COMMHUB_APP_ID": " '  app-id-xyz  ' ",
            "COMMHUB_API_KEY": "'api-key-123'",
            "JWT_SECRET": '"  jwt-secret  "',
        })
        assert res["ok"] is True, res
        v = res["values"]
        assert v["COMMHUB_APP_ID"] == "app-id-xyz", v
        assert v["COMMHUB_API_KEY"] == "api-key-123", v
        assert v["JWT_SECRET"] == "jwt-secret", v
        assert v["DB_NAME"] == "copythat", v


# ================================================================
# 4) Invalid MONGO_URL -> Swedish RuntimeError with masked password
# ================================================================
class TestInvalidMongoUrl:
    def test_bad_url_masked_password(self):
        res = _run_core_import({
            "MONGO_URL": "mongodb://u:p@h:27017//",
            "DB_NAME": "copythat",
            "COMMHUB_APP_ID": "x",
            "COMMHUB_API_KEY": "y",
            "JWT_SECRET": "z",
        })
        assert res["ok"] is False, f"expected import failure, got: {res}"
        assert res["error_type"] == "RuntimeError", res
        msg = res["error_msg"]
        assert msg.startswith("MONGO_URL är ogiltig"), f"wrong prefix: {msg!r}"
        # password 'p' must be masked
        assert ":p@" not in msg, f"password 'p' leaked: {msg!r}"
        assert "****@" in msg, f"expected '****@' mask in message: {msg!r}"
        # username should still be visible
        assert "u:****@h" in msg, f"expected 'u:****@h' pattern: {msg!r}"
        # Swedish helper hint
        assert "URL-kodas" in msg or "mongodb+srv" in msg, msg

    def test_bad_url_longer_password_masked(self):
        res = _run_core_import({
            "MONGO_URL": "mongodb://alice:S3cretPass@host:27017//",
            "DB_NAME": "copythat",
            "COMMHUB_APP_ID": "x",
            "COMMHUB_API_KEY": "y",
            "JWT_SECRET": "z",
        })
        assert res["ok"] is False, res
        assert res["error_type"] == "RuntimeError"
        msg = res["error_msg"]
        assert msg.startswith("MONGO_URL är ogiltig"), msg
        assert "S3cretPass" not in msg, f"password leaked: {msg!r}"
        assert "alice:****@host" in msg, msg


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
