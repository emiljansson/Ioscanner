"""Unit tests for ai.strip_json / ai.call_ai (Gemini RECITATION/SAFETY handling).

These are pure in-process tests (no network): they exercise the parser's new
LaTeX / raw newline / truncation / empty / garbage behaviour and the Gemini
RECITATION detection in call_ai.
"""
import sys
from pathlib import Path
import pytest
from unittest.mock import patch, AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ai import strip_json, AIError, call_ai  # noqa: E402


# ---------- strip_json ----------
class TestStripJsonValid:
    def test_plain_valid_json(self):
        out = strip_json('{"markdown": "hej", "self_confidence": 90}')
        assert out == {"markdown": "hej", "self_confidence": 90}

    def test_fenced_json_block_with_language_tag(self):
        raw = '```json\n{"markdown": "a", "x": 1}\n```'
        assert strip_json(raw) == {"markdown": "a", "x": 1}

    def test_fenced_without_language_tag(self):
        raw = '```\n{"markdown": "b"}\n```'
        assert strip_json(raw) == {"markdown": "b"}


class TestStripJsonLatex:
    def test_latex_backslash_sqrt_inside_string(self):
        # Gemini sometimes emits raw LaTeX backslashes inside JSON strings.
        # Those are illegal JSON escapes; strip_json must repair them.
        raw = '{"markdown": "The formula is $\\sqrt{x}$ and $\\alpha$."}'
        out = strip_json(raw)
        assert "\\sqrt" in out["markdown"]
        assert "\\alpha" in out["markdown"]

    def test_latex_chem_formula(self):
        raw = '{"markdown": "$\\mathrm{H_2O}$"}'
        out = strip_json(raw)
        assert "\\mathrm" in out["markdown"]


class TestStripJsonRawNewlines:
    def test_fenced_block_with_raw_newlines_in_string(self):
        # strict=False allows raw newlines/tabs inside strings.
        raw = '```json\n{"markdown": "line1\nline2\nline3"}\n```'
        out = strip_json(raw)
        assert "line1" in out["markdown"] and "line3" in out["markdown"]


class TestStripJsonTruncated:
    def test_truncated_long_markdown_salvaged(self):
        # Simulate MAX_TOKENS cut-off: JSON is unterminated but markdown field is long.
        big = "A" * 500
        raw = '{"markdown": "' + big + ' more text that got cut mid-string'
        out = strip_json(raw)
        assert out.get("truncated") is True
        assert isinstance(out.get("markdown"), str) and len(out["markdown"]) > 200

    def test_truncated_short_markdown_raises(self):
        # Too short to salvage -> must raise AIError
        raw = '{"markdown": "short cut off'
        with pytest.raises(AIError) as e:
            strip_json(raw)
        assert "giltig JSON" in str(e.value)


class TestStripJsonEmptyAndGarbage:
    def test_empty_string_raises_tomt(self):
        with pytest.raises(AIError) as e:
            strip_json("")
        assert "tomt svar" in str(e.value)

    def test_whitespace_only_raises_tomt(self):
        with pytest.raises(AIError) as e:
            strip_json("   \n\t  ")
        assert "tomt svar" in str(e.value)

    def test_garbage_raises_invalid_json(self):
        with pytest.raises(AIError) as e:
            strip_json("totally not json <<<")
        assert "giltig JSON" in str(e.value)


# ---------- call_ai Gemini RECITATION/SAFETY handling ----------
class TestCallAIGeminiFilters:
    @pytest.mark.asyncio
    async def test_gemini_recitation_empty_raises_filter_error(self):
        fake_response = {
            "candidates": [{"finishReason": "RECITATION", "content": {"parts": []}}]
        }
        with patch("ai.get_ai_keys", new=AsyncMock(return_value={"gemini": "fake"})), \
             patch("ai._post", new=AsyncMock(return_value=fake_response)):
            with pytest.raises(AIError) as e:
                await call_ai("gemini", "gemini-x", "p", None, 10, want_json=True)
            msg = str(e.value)
            assert "filter" in msg
            assert "RECITATION" in msg

    @pytest.mark.asyncio
    async def test_gemini_safety_empty_raises_filter_error(self):
        fake_response = {
            "candidates": [{"finishReason": "SAFETY", "content": {"parts": []}}]
        }
        with patch("ai.get_ai_keys", new=AsyncMock(return_value={"gemini": "fake"})), \
             patch("ai._post", new=AsyncMock(return_value=fake_response)):
            with pytest.raises(AIError) as e:
                await call_ai("gemini", "gemini-x", "p", None, 10, want_json=True)
            assert "filter" in str(e.value)

    @pytest.mark.asyncio
    async def test_gemini_recitation_with_text_does_not_raise(self):
        # If text came through alongside RECITATION, we keep it.
        fake_response = {
            "candidates": [{
                "finishReason": "RECITATION",
                "content": {"parts": [{"text": '{"markdown":"ok"}'}]}
            }]
        }
        with patch("ai.get_ai_keys", new=AsyncMock(return_value={"gemini": "fake"})), \
             patch("ai._post", new=AsyncMock(return_value=fake_response)):
            out = await call_ai("gemini", "gemini-x", "p", None, 10, want_json=True)
            assert '"markdown"' in out
