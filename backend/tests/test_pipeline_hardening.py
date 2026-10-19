"""Pipeline hardening tests (iteration 20):

Covers the Railway "stuck on AI analysis" hardening added in /app/backend/pipeline.py:

1. process_page wraps _process_page in asyncio.wait_for(PAGE_TIMEOUT_S) -> on timeout
   the page row is updated to status='error' with the Swedish timeout message.
2. resume_pending() with resumes >= MAX_RESUMES (2) on a 'processing' page -> marks
   the page as 'error' and resets resumes to 0 (does NOT re-enqueue).
3. resume_pending() with resumes=0 on a 'processing' page -> increments resumes to 1
   AND re-enqueues the page via process_page.

All tests run in-process against the real Mongo (MONGO_URL/DB_NAME) and clean up
every row they create. We never touch real user data: every inserted page row has
a 'TEST_' prefix in source_name and is deleted in a finally/addfinalizer block.
"""
import asyncio
import os
import sys
import pytest
import pymongo
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

# Make /app/backend importable so we can monkeypatch pipeline internals in-process.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pipeline  # noqa: E402
from core import new_id, now  # noqa: E402

MDB = pymongo.MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]


# Motor's AsyncIOMotorClient (pipeline.db) binds to the first event loop that uses it.
# Share a single loop across all tests in this module so Motor cursors stay valid.
@pytest.fixture(scope="module")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


def _run(coro, loop):
    return loop.run_until_complete(coro)


# --------- helpers ---------
def _insert_test_page(status: str = "queued", resumes: int | None = None, document_id: str | None = None) -> str:
    pid = new_id()
    doc = {
        "id": pid,
        "user_id": "TEST_pipeline_user",
        "document_id": document_id or f"TEST_doc_{pid[:8]}",
        "order": 0,
        "source_name": "TEST_pipeline_hardening.jpg",
        "source_index": 1,
        "status": status,
        "error": None,
        "image_url": "https://example.invalid/none.jpg",
        "image_file_id": None,
        "width": 100, "height": 100,
        "markdown": "", "confidence": None, "page_number": None,
        "figures": [], "attempts": 0,
        "created_at": now(), "updated_at": now(),
    }
    if resumes is not None:
        doc["resumes"] = resumes
    MDB.pages.insert_one(doc)
    return pid


def _get_page(pid: str) -> dict | None:
    return MDB.pages.find_one({"id": pid}, {"_id": 0})


def _cleanup(pids: list[str]) -> None:
    if pids:
        MDB.pages.delete_many({"id": {"$in": pids}})


# =============================================================
# 1) process_page timeout -> status=error, Swedish message
# =============================================================
class TestProcessPageTimeout:
    def test_timeout_marks_page_error_with_swedish_message(self, monkeypatch):
        pid = _insert_test_page(status="queued")
        try:
            # Shrink timeout so the test is fast.
            monkeypatch.setattr(pipeline, "PAGE_TIMEOUT_S", 1)

            # Replace _process_page with a slow coroutine that first flips the row
            # to 'processing' (mirroring real behaviour) and then sleeps forever.
            async def slow(page_id, rescan=False):
                MDB.pages.update_one({"id": page_id}, {"$set": {"status": "processing"}})
                await asyncio.sleep(30)

            monkeypatch.setattr(pipeline, "_process_page", slow)

            async def run():
                await pipeline.process_page(pid)

            asyncio.run(run())

            page = _get_page(pid)
            assert page is not None, "page row disappeared"
            assert page["status"] == "error", f"expected status=error, got {page['status']}"
            err = page.get("error") or ""
            # Swedish message from pipeline.py:203
            assert "Analysen tog för lång tid" in err, f"unexpected error: {err!r}"
            # f-string embeds PAGE_TIMEOUT_S // 60 — with timeout=1 that's '0 min'.
            # Just verify the "min" / "Försök igen" tail is present.
            assert "min" in err and "Försök igen" in err, f"unexpected error tail: {err!r}"
        finally:
            _cleanup([pid])

    def test_timeout_does_not_overwrite_already_errored_page(self, monkeypatch):
        """The timeout write is guarded by {status: 'processing'} so a page that already
        failed with a real error keeps its original message."""
        pid = _insert_test_page(status="error")
        MDB.pages.update_one({"id": pid}, {"$set": {"error": "Original AI error"}})
        try:
            monkeypatch.setattr(pipeline, "PAGE_TIMEOUT_S", 1)

            async def slow(page_id, rescan=False):
                # Do NOT flip to processing — leaves row in 'error' from the previous run.
                await asyncio.sleep(30)

            monkeypatch.setattr(pipeline, "_process_page", slow)

            async def run():
                await pipeline.process_page(pid)

            asyncio.run(run())

            page = _get_page(pid)
            assert page["status"] == "error"
            assert page["error"] == "Original AI error", (
                f"timeout handler overwrote a non-processing row: {page['error']!r}"
            )
        finally:
            _cleanup([pid])


# =============================================================
# 2) resume_pending: resumes >= MAX_RESUMES -> error, no re-enqueue
# 3) resume_pending: resumes=0 -> resumes becomes 1 AND re-enqueued
# =============================================================
class TestResumePending:
    def test_resumes_at_max_marked_error_and_not_enqueued(self, monkeypatch):
        pid = _insert_test_page(status="processing", resumes=pipeline.MAX_RESUMES)
        try:
            calls: list[str] = []
            # Patch enqueue so we can detect re-enqueuing (and avoid spawning real tasks).
            monkeypatch.setattr(pipeline, "enqueue", lambda page_id, rescan=False: calls.append(page_id))

            asyncio.run(pipeline.resume_pending())

            page = _get_page(pid)
            assert page is not None
            assert page["status"] == "error", f"expected error, got {page['status']}"
            # Swedish message from pipeline.py:307
            assert "Servern startade om" in (page.get("error") or ""), f"bad error: {page.get('error')!r}"
            # resumes is reset to 0 so the user can retry
            assert page.get("resumes") == 0, f"resumes should be reset to 0, got {page.get('resumes')}"
            # The failing page must NOT be re-enqueued
            assert pid not in calls, f"page was re-enqueued despite >= MAX_RESUMES: {calls}"
        finally:
            _cleanup([pid])

    def test_resumes_zero_increments_and_enqueues(self, monkeypatch):
        pid = _insert_test_page(status="processing", resumes=0)
        try:
            calls: list[str] = []
            monkeypatch.setattr(pipeline, "enqueue", lambda page_id, rescan=False: calls.append(page_id))

            asyncio.run(pipeline.resume_pending())

            page = _get_page(pid)
            assert page["status"] == "processing", "status must stay 'processing' for a resumed page"
            assert page.get("resumes") == 1, f"resumes should be incremented to 1, got {page.get('resumes')}"
            assert pid in calls, f"page should be re-enqueued, calls={calls}"
        finally:
            _cleanup([pid])

    def test_queued_page_is_enqueued_without_incrementing(self, monkeypatch):
        """'queued' pages were never started, so resumes must not be touched —
        only 'processing' pages count as interrupted."""
        pid = _insert_test_page(status="queued")
        # No 'resumes' field at all on this one.
        try:
            calls: list[str] = []
            monkeypatch.setattr(pipeline, "enqueue", lambda page_id, rescan=False: calls.append(page_id))

            asyncio.run(pipeline.resume_pending())

            page = _get_page(pid)
            assert page["status"] == "queued"
            # Must not have been given a resumes counter for a page that never started.
            assert page.get("resumes") in (None, 0), f"queued page got resumes={page.get('resumes')}"
            assert pid in calls, "queued page must still be enqueued"
        finally:
            _cleanup([pid])

    def test_resumes_one_increments_to_two_and_enqueues(self, monkeypatch):
        """One under the threshold — resumes=1 should become 2 and still be enqueued."""
        pid = _insert_test_page(status="processing", resumes=1)
        try:
            calls: list[str] = []
            monkeypatch.setattr(pipeline, "enqueue", lambda page_id, rescan=False: calls.append(page_id))

            asyncio.run(pipeline.resume_pending())

            page = _get_page(pid)
            assert page["status"] == "processing"
            assert page.get("resumes") == 2
            assert pid in calls
        finally:
            _cleanup([pid])


# =============================================================
# 4) Config sanity: env-driven knobs are honoured
# =============================================================
class TestPipelineConfig:
    def test_defaults_present(self):
        # PAGE_TIMEOUT_S should default to 600 (10 minutes) when env unset.
        assert isinstance(pipeline.PAGE_TIMEOUT_S, int)
        assert pipeline.PAGE_TIMEOUT_S >= 60, "unreasonably low default page timeout"
        # Semaphore exists and is bounded.
        assert isinstance(pipeline._sem, asyncio.Semaphore)
        # MAX_RESUMES guards the crash-loop
        assert pipeline.MAX_RESUMES == 2
