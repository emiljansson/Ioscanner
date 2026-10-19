# Publicera CopyThat på Railway

Repo: **iosscanner**, gren **fullscanner** (sparas via "Save to GitHub" i Emergent).
Railway kör två tjänster från samma repo. Databasen är MongoDB Atlas.

| Tjänst | Root Directory | Bygger med | Innehåll |
|---|---|---|---|
| `copythat-api` | `/backend` | `backend/Dockerfile` + `backend/railway.json` | FastAPI, pandoc, OpenCV, PDF, teckensnitt |
| `copythat-web` | `/frontend` | `frontend/Dockerfile` + `frontend/railway.json` | Webbversionen (statisk Expo-export, körs med `serve`) |

iPhone-appen byggs fortfarande via **Publish** i Emergent. Railway sköter bara servern och webben.

---

## 1. MongoDB Atlas
1. Skapa en databasanvändare i Atlas under *Database Access*.
2. Gå till *Network Access* och lägg till `0.0.0.0/0`. Railway har inga fasta IP-adresser.
3. Kopiera anslutningssträngen, till exempel `mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`.

## 2. Tjänsten copythat-api
1. Railway → **New Project → Deploy from GitHub repo** → välj `iosscanner`.
2. Ställ in **Settings → Source → Branch** på `fullscanner` och **Root Directory** på `/backend`.
3. Lägg in **Variables**:

| Variabel | Värde |
|---|---|
| `MONGO_URL` | Anslutningssträngen från Atlas |
| `DB_NAME` | `copythat` (eller valfritt namn) |
| `COMMHUB_APP_ID` | Ditt CommHub-app-id |
| `COMMHUB_API_KEY` | Din CommHub-nyckel (med behörighet för keychain, email och files) |
| `JWT_SECRET` | En lång slumpad sträng, till exempel `openssl rand -hex 32` |
| `OWNER_EMAIL` | `emil@jawel.se` |
| `TEST_LOGIN_EMAIL` / `TEST_LOGIN_CODE` | **Lägg inte in i produktion.** Bara för test. |
| `OPENAI_API_KEY` / `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` | Valfria reservnycklar. Normalt hämtas AI-nycklarna från CommHubs nyckelförråd. |

4. Gå till **Settings → Networking → Generate Domain**. Då får du till exempel `https://copythat-api.up.railway.app`.
5. Kontrollera att `https://<api-domän>/api/health` svarar.

`PORT` sätts automatiskt av Railway och ska inte läggas in.

## 3. Tjänsten copythat-web
1. Välj **New → GitHub Repo** i samma projekt, välj `iosscanner`, gren `fullscanner` och Root Directory `/frontend`.
2. Lägg in **Variables**:

| Variabel | Värde |
|---|---|
| `EXPO_PUBLIC_BACKEND_URL` | API-domänen **utan** `/api`, till exempel `https://copythat-api.up.railway.app` |

   Variabeln byggs in i webbversionen när den byggs. Om du ändrar den måste du göra **Redeploy**.
3. Gå till **Generate Domain**, eller lägg till en egen domän, till exempel `copythat.jawel.se`.

## 4. Efter publiceringen
- Logga in på webben med din e-post. Koden skickas via CommHub.
- **NAPS2-skriptet:** gå till Inställningar → *Skanna från datorn* och ladda ner eller mejla skriptet **igen**. Det innehåller serverns adress, och adressen är ny.
- **iPhone-appen:** appen anropar adressen i `EXPO_PUBLIC_BACKEND_URL` som den hade när den byggdes. Om iPhone-appen ska använda Railway-servern måste `EXPO_PUBLIC_BACKEND_URL` peka på Railway-API:t i bygget.
- Data i den nuvarande förhandsvisningsdatabasen flyttas **inte** med automatiskt. Använd `mongodump`/`mongorestore` om du vill ta med den.

## Filer för Railway
- `backend/Dockerfile`, `backend/.dockerignore`, `backend/railway.json`
- `frontend/Dockerfile`, `frontend/.dockerignore`, `frontend/railway.json`, `frontend/serve.json` (gör att adresser som `/doc/<id>` och `/preview/<id>` fungerar)

`.env`-filerna kopieras aldrig in i bygget. Alla hemligheter läggs in som Railway Variables.
