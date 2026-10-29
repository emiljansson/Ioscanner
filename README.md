# CopyThat / Ioscanner

Dokument- och skannerapp med e-postkodsinloggning, kurser och dokument, sidhantering, OCR/AI-bearbetning samt export av dokument och bilder. Backend innehåller export till bland annat PDF, Word och ZIP.

## Arkitektur och kodvägar

Den medföljande Dockerfilen bygger frontend/ som Expo-webb och kör backend/ med FastAPI. MongoDB lagrar data; CommHub används för inloggning, filer och nyckeltjänster.

- [Dockerfile](Dockerfile)
- [frontend/src/api.ts](frontend/src/api.ts)
- [frontend/app/capture.tsx](frontend/app/capture.tsx)
- [backend/server.py](backend/server.py)
- [backend/core.py](backend/core.py)
- [backend/pipeline.py](backend/pipeline.py)
- [backend/export.py](backend/export.py)

## Utveckling och konfiguration

Paket i `.` (manifest: `package.json`). Kör pakethanteraren i den katalogen. Deklarerade kommandon:

- `yarn start`: `expo start`
- `yarn android`: `expo start --android`
- `yarn ios`: `expo start --ios`
- `yarn web`: `expo start --web`
- `yarn lint`: `expo lint`

Paket i `frontend` (manifest: `frontend/package.json`). Kör pakethanteraren i den katalogen. Deklarerade kommandon:

- `yarn start`: `expo start`
- `yarn android`: `expo start --android`
- `yarn ios`: `expo start --ios`
- `yarn web`: `expo start --web`
- `yarn lint`: `expo lint`

Pythonberoenden finns i `backend/requirements.txt`. Skapa en separat virtuell miljö och installera med `python -m pip install -r backend/requirements.txt`. FastAPI-objektet är `server:app` med arbetskatalog `backend/`; kontrollera konfiguration och start-/bakgrundsjobb före start.

Miljövariabler som refereras i den lästa applikationskoden (alla är inte obligatoriska):

`ANTHROPIC_API_KEY`, `EXPO_PUBLIC_BACKEND_URL`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `OWNER_EMAIL`, `PAGE_CONCURRENCY`, `PAGE_TIMEOUT_S`, `TEST_LOGIN_CODE`, `TEST_LOGIN_EMAIL`, `WEB_DIR`.

Läs respektive konfigurationsmodul för krav och standardvärden. Hemliga värden ska konfigureras separat och aldrig läggas i README eller klientpaket.

## Begränsningar och saker att kontrollera

Rotens app/ och src/ är en separat klientvariant; _archive/ är historik. Välj inte kodversion enbart efter mappnamn. backend/core.py kräver MONGO_URL, DB_NAME, COMMHUB_APP_ID, COMMHUB_API_KEY och JWT_SECRET. AI kräver respektive leverantörs behörighet/nyckel. Dockerfilen använder Python 3.11 och Node 22; fungerande bygge har inte verifierats här.

## Underlag för nästa agent

Läs aktuella instruktioner och `git status --short` innan ändringar. Börja i kodvägarna ovan och följ anrop till datalager och externa tjänster. Befintliga testfiler omfattar exempelvis `backend/tests/test_ai_flow.py`, `backend/tests/test_backend.py`, `backend/tests/test_bildstod.py`, `backend/tests/test_core_env_validation.py`, `backend/tests/test_email_zip.py`, `backend/tests/test_figures_and_zip.py`. Tester och kommandon ovan är upptäckta i koden; de har inte körts som del av README-arbetet. Nya webbservrar på HPZ840 ska vara åtkomliga via Tailscale enligt Jarvis instruktioner.

Kodbaserat dokumentationsunderlag granskat 2026-10-25, commit `5328341e39f99801bb688844486fbeb3ab6f0223`. Beskriver kodens avsedda beteende; ingen drift-, bygg- eller integrationsverifiering har utförts. Inget har skickats till GitHub.
