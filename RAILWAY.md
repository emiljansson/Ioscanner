# Publicera CopyThat på Railway (en tjänst)

Repo: **iosscanner**, gren **main** (sparas via "Save to GitHub" i Emergent).
Allt körs i **en enda Railway-tjänst**. FastAPI-servern sköter `/api/...` och visar dessutom webbversionen på samma adress. Databasen är MongoDB Atlas.

| Fil | Vad den gör |
|---|---|
| `Dockerfile` (i roten) | Bygger först webbversionen (Expo-export) och sedan servern, som tar med webbversionen och pandoc, OpenCV, PDF-stöd och teckensnitt |
| `railway.json` (i roten) | Säger åt Railway att bygga med Dockerfile och att hälsokontrollen finns på `/api/health` |
| `.dockerignore` (i roten) | Håller `.env`, `node_modules` och tester utanför bygget |

iPhone-appen byggs fortfarande via **Publish** i Emergent.

---

## 1. MongoDB Atlas
1. Skapa en databasanvändare i Atlas under *Database Access*.
2. Gå till *Network Access* och lägg till `0.0.0.0/0`. Railway har inga fasta IP-adresser.
3. Kopiera anslutningssträngen, till exempel `mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`.

## 2. Railway-tjänsten
1. Railway → **New Project → Deploy from GitHub repo** → välj `iosscanner`.
2. Ställ in **Settings → Source → Branch** på `main`. Låt **Root Directory** vara tomt, alltså roten.
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

   `PORT` och `WEB_DIR` sätts automatiskt och ska inte läggas in.
4. Gå till **Settings → Networking → Generate Domain**, eller lägg till en egen domän, till exempel `copythat.jawel.se`.
5. Kontrollera att `https://<domän>/` visar inloggningen och att `https://<domän>/api/health` svarar `{"ok": true}`.

### Om bygget kör `pip install -r requirements.txt` med Python 3.13
Då använder Railway inte vår `Dockerfile`, utan gissar själv hur appen ska byggas (Railpack). Det beror nästan alltid på att **Root Directory** är satt till `/backend`.
- Gå till **Settings → Source → Root Directory**, töm fältet och spara.
- Under **Settings → Build** ska *Builder* vara **Dockerfile** (det står också i `railway.json`).
- Gör **Redeploy**. I loggen ska det nu stå `FROM node:22-slim` och `FROM python:3.11-slim`.

## 3. Efter publiceringen
- Logga in på webben med din e-post. Koden skickas via CommHub.
- **NAPS2-skriptet:** gå till Inställningar → *Skanna från datorn* och ladda ner eller mejla skriptet **igen**. Det innehåller serverns adress, och adressen är ny.
- **iPhone-appen:** appen anropar adressen i `EXPO_PUBLIC_BACKEND_URL` som den hade när den byggdes. Om iPhone-appen ska använda Railway-servern måste `EXPO_PUBLIC_BACKEND_URL` vara Railway-domänen (utan `/api`) i bygget.
- Data i den nuvarande förhandsvisningsdatabasen flyttas **inte** med automatiskt. Använd `mongodump`/`mongorestore` om du vill ta med den.

## Hur det fungerar
- Webbversionen byggs utan egen serveradress och anropar därför `/api` på samma domän.
- Servern skickar tillbaka webbsidorna för alla adresser som inte börjar med `/api`. Även `/doc/<id>` och `/preview/<id>` fungerar.
- I Emergents förhandsvisning är `WEB_DIR` inte satt. Där fungerar allt som vanligt.
