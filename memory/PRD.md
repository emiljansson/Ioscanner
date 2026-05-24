# CopyThat — PRD

## Overview
Standalone iOS-first OCR scanner app. Takes photos of documents, runs AI OCR
directly from the device (no backend), structures text per page with bold
headings, surfaces a confidence percentage with rescan-to-improve loop,
auto-paginates the scan set, and lets the user copy all text to the clipboard.

Users bring their own AI API keys (OpenAI, Google Gemini, or Anthropic Claude),
entered in an in-app Settings screen and stored locally in iOS Keychain /
Android Keystore. No backend, no remote storage, no email sending.

## Tech Stack
- Frontend: Expo SDK 54 + React Native + expo-router (file-based)
- Backend: **None.** App is 100% standalone frontend.
- AI: direct HTTPS fetch from the device to each provider's REST endpoint
  - OpenAI GPT-5.5 — `POST https://api.openai.com/v1/responses`
  - Google Gemini 3.1 Pro Preview — `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent`
  - Anthropic Claude Sonnet 4.5 — `POST https://api.anthropic.com/v1/messages`
    (uses `anthropic-dangerous-direct-browser-access: true` header for RN)
- State: React Context (`ScansProvider`) — in-memory only

## Settings & API Keys
- Three independent provider cards (OpenAI / Gemini / Anthropic)
- Tapping a card sets it as the **primary** (active) provider used for OCR
- Each card has a "Use for verification" checkbox that enables it as a
  verifier in **Consensus Mode** (see below)
- Keys are stored via `expo-secure-store` (Keychain on iOS, EncryptedSharedPrefs on Android)
- "Test" button pings the provider with a tiny prompt to validate the key
- "Get key from …" opens the provider's console URL

## Consensus Mode (korsverifiering)
When the user enables "Use for verification" on one or more non-primary
providers, every OCR scan fans out in parallel:
- Primary call returns full JSON (structured + plain text + self-confidence)
- Each verifier returns plain text only
- We compute token-Jaccard `similarity(primary.plain_text, verifier.plain_text)`
  for each verifier, average them → `consensus_score` (0–100)
- Final confidence formula:
  ```
  base = 0.30 * self_confidence + 0.25 * coherence_score + 0.45 * consensus_score
  confidence = clamp(base * (is_document_likelihood/100) + bonus_per_attempt, 0, 99)
  ```
  If no verifiers enabled: `base = 0.55 * self_confidence + 0.45 * coherence_score`
- Hard guard: if `is_document_likelihood < 20` or extracted text < 8 chars,
  confidence collapses to ≤15 (prevents "ceiling looks great" scores)

## Frontend Screens (`/app/frontend/app`)
- `_layout.tsx` — Stack + `ScansProvider` (in-memory store)
- `index.tsx` — camera with overlay frame, shutter, scanned-pages pill,
  Pages button, Settings shortcut, flash auto/on/off cycle
- `pages.tsx` — list of all scans, auto-organised by detected/inferred page
  number, "Copy all text" button (uses `expo-clipboard`)
- `page/[id].tsx` — per-page detail with image, confidence badge (colour-coded),
  bolded headings, edit toggle, rescan button when confidence < 90%,
  shows consensus score / verifier names if any ran
- `settings.tsx` — three provider cards, key input + visibility toggle,
  Save / Test, "Use for verification" checkbox, links to provider consoles

## Smart Pagination (`runOrganize`)
Pages without a detected `page_number` get an inferred one based on neighbours'
numbers and text context. Two pages may never share the same final number —
collisions fall through to the next free integer. Fallback (if AI call fails):
sequential fill of gaps in capture order.

## Permissions
- iOS `NSCameraUsageDescription` set in `app.json`
- Android `CAMERA` permission set
- `expo-camera` plugin configured

## Env Vars
- **None required.** All credentials are user-provided via Settings.
- `/app/backend/.env` is unused by the app at runtime (legacy file).

## Storage
- `expo-secure-store`: each provider's API key + active provider + verifier flags
- `@react-native-async-storage/async-storage`: persisted scans array (key
  `copythat.scans.v1`). Hydrated on `ScansProvider` mount.
- `expo-file-system` legacy API: captured images are copied from the camera
  cache to `${documentDirectory}scans/<scanId>.<ext>` so they survive app
  restarts. Images are deleted when the corresponding scan is removed or
  rescanned.
- No remote database, no MongoDB, no FastAPI.

## Build & Deploy
- Expo configuration is duplicated at both `/app/app.json`+`/app/eas.json` and
  `/app/frontend/app.json`+`/app/frontend/eas.json` to support EAS builds from
  the GitHub repo root via launch.expo.dev.
- App name: **CopyThat** with vintage duplicator icon at `/app/frontend/assets/images/`.

## Known Limitations
- Camera does not work in the web preview tunnel (browser blocks getUserMedia
  on the iframe). Real camera capture requires Expo Go iOS app or a native build.
- Anthropic's CORS / browser policy requires the
  `anthropic-dangerous-direct-browser-access` header; this is fine on RN native
  but may be flagged in some web environments.
