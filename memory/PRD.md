# Jawel Scanner — PRD

## Overview
Swedish iOS-first OCR scanner app. Takes photos of documents, runs dualhead AI OCR
(GPT-5.2 + Gemini 3.1 Pro in parallel), structures the text per page with bold
headers, surfaces a confidence percentage with a rescan-to-improve loop, and
emails the combined result to fixed recipients through commhub.cloud.

## Tech Stack
- Frontend: Expo SDK 54 + React Native + expo-router (file-based)
- Backend: FastAPI (single `server.py`) + MongoDB (motor)
- AI: `emergentintegrations.llm.chat` with EMERGENT_LLM_KEY
  - GPT-5.2 (`openai/gpt-5.2`) — primary OCR, returns JSON with `structured_text`
    (markdown with `**bold**` for headers), `plain_text`, `self_confidence`.
  - Gemini 3.1 Pro Preview (`gemini/gemini-3.1-pro-preview`) — verifier, returns
    verbatim plain text. Used to compute similarity-based confidence.
- Email: commhub.cloud `POST /api/email/send` (x-api-key + app_id)

## Backend Endpoints
- `GET /api/health` → `{ok, llm_key, commhub}`
- `POST /api/ocr/scan` body `{image_base64}` → `ScanResult`
- `POST /api/ocr/rescan` body `{image_base64, previous_text, previous_confidence, attempts}` → `ScanResult`
  - Always increments `attempts`; enforces `confidence >= previous_confidence`.
- `POST /api/email/send` body `{to[], subject, body_markdown}` → `{ok, status_code, response}`
  - Markdown `**bold**` is converted to `<strong>` for the HTML body; plain text body
    is `**` stripped.

### Confidence formula
`confidence = 0.45 * similarity(gpt_plain, gemini_plain)*100 + 0.25 * gpt_self_confidence + 0.30 * coherence_score`
plus a `+4` per re-attempt bonus capped at `+12`, hard-capped at 99. Re-attempts
are guaranteed to be `>= previous_confidence`.

`coherence_score` is asked from GPT-5.2 separately: it grades how semantically
plausible the text is as a real document (logical flow, sentence structure,
plausible values) — **not** whether individual words are spelled correctly.
This catches "all valid Swedish words but in random order" cases.

`coherence_note` (≤120 chars) is shown to the user as a yellow warning banner
when `coherence_score < 70`.

## Frontend Screens (`/app/frontend/app`)
- `_layout.tsx` — Stack + `ScansProvider` (in-memory store)
- `index.tsx` — camera with overlay frame, capture shutter, scanned-pages pill,
  mail button. Shows "Dualhead AI läser…" overlay while scanning.
- `page/[id].tsx` — per-page detail with image, confidence badge (color-coded),
  bolded headings rendering, edit toggle, rescan button when confidence < 90%.
- `email.tsx` — subject input, 2×2 grid of 4 fixed recipients
  (Emil/Louise/Anton/William @jawel.se), pages summary with confidence chips,
  send button. Toast on success then returns to camera.

## Permissions
- iOS `NSCameraUsageDescription` set in `app.json`
- Android `CAMERA` permission set
- `expo-camera` plugin configured

## Env Vars (`/app/backend/.env`)
- `MONGO_URL`, `DB_NAME`
- `EMERGENT_LLM_KEY`
- `COMMHUB_API_KEY`, `COMMHUB_APP_ID`, `COMMHUB_FROM=Ioscanner@grindstugatan.se`

## Storage
- MongoDB collections: `scans`, `email_log`. UUID `id` field; `_id` is never
  returned to clients.

## Known Limitations
- Camera does not work in the web preview tunnel (browser blocks getUserMedia
  on the iframe). Real camera capture requires the Expo Go iOS app or a build.
- Multi-page state is in-memory only — refreshing clears the session.
