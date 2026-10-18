# CopyThat Webb – AI-OCR för kurs- och studiematerial

CopyThat Webb är ett webbprogram som tar emot scannat eller fotograferat material, läser av det med AI och gör om det till redigerbara Word-dokument med text, formler, tabeller och utklippta bilder.
Materialet kan sedan bearbetas till något nytt med fria AI-instruktioner. iOS-appen CopyThat använder samma server och samma arkiv.

---

## Målgrupp

- Ägaren (emil@jawel.se) och ett fåtal inbjudna personer.
- Användningen gäller främst **kurs- och studiematerial**: läroböcker, kompendier, föreläsningsanteckningar och övningsblad.
- Tjänsten är privat. Ingen kan registrera sig själv, utan bara de som ägaren har bjudit in kan logga in.

---

## Funktioner och upplevelse

### 1. Inloggning
- Inloggning med **e-post och engångskod**. En sexsiffrig kod skickas till e-posten, gäller i 10 minuter och kan bara användas en gång.
- Inloggningen och kodutskicken sköts av **CommHub** (commhub.cloud), samma tjänst för webben och iOS-appen.
- Ägaren kan bjuda in och ta bort användare.

### 2. AI-nycklar på servern
- Nycklarna till OpenAI, Gemini och Anthropic läggs in **en gång på servern**. De visas aldrig i webbläsaren, i appen eller i skript.
- Inställningen för läsläge finns kvar: **Snabb** (en AI), **Balanserad** och **Bäst** (consensus mellan 2–3 AI:er med säkerhetspoäng).

### 3. Ta in material
- **Dra och släpp** eller välj filer: JPG, PNG, HEIC, WebP, TIFF och **flersidiga PDF:er**.
- Flera filer åt gången. En PDF delas automatiskt upp i sidor.
- Material från scannern (HP Color LaserJet Pro MFP 3302) scannas med NAPS2 eller skrivarens egen funktion, sparas som PDF och laddas upp på samma sätt.
- Material kan **bara** komma in via webbprogrammet eller iOS-appen, alltid av en inloggad användare. Det finns ingen inmatning via e-post, skript eller Home Assistant.
- I iOS-appen finns kameran, bildbiblioteket och Filer kvar, men allt skickas till servern.

### 4. AI-OCR anpassad för studiematerial
- Text, rubriknivåer, listor och stycken återskapas med samma textstädning som i dagens app: avstavningar läggs ihop och rubriker känns igen.
- **Matteformler** blir riktiga, redigerbara Word-ekvationer.
- **Tabeller** blir riktiga Word-tabeller.
- **Flerspaltig layout** läses i rätt ordning.
- Sidhuvud, sidfot och sidnummer tas bort från texten.
- Varje sida får en **säkerhetspoäng** och kan läsas om ("Förbättra sida").

### 5. Bildutklipp
- AI:n hittar **foton, diagram, figurer och illustrationer** på varje sida.
- De klipps ut i full upplösning och placeras **på rätt ställe i texten**, med bildtext om en sådan finns.
- PDF:er med inbäddade originalbilder ger originalet direkt, i bästa kvalitet.
- Varje utklipp kan **tas bort eller beskäras om för hand**.

### 6. Arkiv: Kurs → Dokument → Sidor
- Material organiseras i **kurser**, t.ex. "Fysik 2". Varje kurs innehåller **dokument**, t.ex. "Kapitel 3 – Rörelse", och varje dokument består av **sidor**.
- Sidorna sorteras automatiskt efter sidnummer och kan flyttas manuellt.
- Texten kan redigeras direkt i programmet.
- Sökning i titlar och text i hela arkivet.
- Samma arkiv syns på webben och i iOS-appen.

### 7. Fria AI-instruktioner
- Välj **en sida, ett helt dokument eller flera dokument**.
- Skriv fritt vad du vill ha, t.ex. *"Gör en sammanfattning med de viktigaste begreppen och 10 övningsfrågor med svar."*
- Resultatet blir ett **nytt dokument** i samma kurs. Originalet lämnas orört.
- Instruktioner som används ofta kan **sparas som mallar**.
- Långa dokument bearbetas med en AI-modell som klarar många sidor, eller kapitel för kapitel.

### 8. Nedladdning
- **Word (.docx)** med rubriker, text, formler, tabeller och bilder på rätt plats.
- **ZIP** med Word-dokumentet, en ren textfil (.txt) och en mapp med alla utklippta bilder.
- Det finns också en snabbknapp för att kopiera all text.

---

## Användarflöde

1. **Logga in:** Ange e-post → få en kod via e-post → skriv in koden.
2. **Välj eller skapa en kurs**, t.ex. "Fysik 2".
3. **Ladda upp material:** dra in PDF:en från NAPS2, bilder eller iPhone-foton. Skapa ett nytt dokument eller lägg till sidor i ett befintligt.
4. **Vänta medan AI:n läser.** Förloppet visas per sida, med AI-status och beräknad tid kvar.
5. **Granska dokumentet:** text och bilder visas sida för sida med säkerhetspoäng. Redigera text, justera bildutklipp och läs om sidor vid behov.
6. **Bearbeta (valfritt):** markera sidor eller dokument → skriv en instruktion eller välj en mall → ett nytt dokument skapas.
7. **Ladda ner** som Word eller ZIP.

På iPhone är flödet detsamma, men fotografering och val av bild ersätter steg 3.

---

## Känsla i gränssnittet (UI/UX)

- **Bred, responsiv layout** för dator. Arkivet ligger i en sidopanel till vänster och dokumentet i mitten. Redigering och AI-instruktioner öppnas i en panel till höger.
- Fungerar också på mobil och surfplatta i webbläsaren.
- Lugn och tydlig "studiemiljö" med god läsbarhet, ett dokument i A4-känsla och diskreta säkerhetsfärger (grön, gul, röd).
- **Allt på svenska**, både webbprogrammet och iOS-appen.
- Stora dra-och-släpp-ytor, tydliga förloppsindikatorer och vänliga felmeddelanden (t.ex. när AI-krediten tar slut).

---

## Faser

### Fas 1 – Hela tjänsten (byggs nu)
- Server med AI-nycklarna, sidavläsning (alla tre AI:er, de tre lägena Snabb/Balanserad/Bäst), textstädning och säkerhetspoäng
- Inloggning med e-post och engångskod via CommHub, med ägaren emil@jawel.se och inbjudan av fler användare
- Lagring av uppladdade filer, sidbilder och utklipp via CommHub
- Webbprogram: bred layout, uppladdning av bilder och flersidiga PDF:er, arkiv (Kurs → Dokument → Sidor), redigering, sökning
- Formler, tabeller och flerspaltig layout
- Bildutklipp som placeras i texten och kan justeras för hand
- Fria AI-instruktioner med sparade mallar
- Nedladdning som Word (.docx) och ZIP
- iOS-appen kopplas till servern: inloggning, gemensamt arkiv, och kamera, bildbibliotek och Filer laddar upp till servern. Kräver ett nytt iOS-bygge.

Fler faser är inte planerade. Allt som ingår i CopyThat Webb finns i fas 1.

---

## Antaganden

- **CommHub** används för inloggning (e-post med engångskod) och fillagring. CopyThat registreras som en egen applikation i ägarens CommHub-konto. En CommHub-API-nyckel och ett app-ID behövs från ägaren när bygget startar.
- Engångskoderna skickas av CommHub och följer CommHubs standard: 6 siffror, gäller 10 minuter, kan bara användas en gång.
- Kurser, dokument och sidor sparas i CopyThats egen databas. CommHub används för inloggning och filer, inte för dokumentdata.
- Ägarens egna AI-nycklar (OpenAI, Gemini, Anthropic) används, inte någon delad nyckel. Ägaren står för AI-kostnaden.
- **Gemini** används för att hitta bilder på sidorna, eftersom den är bra på att peka ut var saker finns i en bild.
- **Snabb** blir standardläget för nya uppladdningar. Övriga lägen kan väljas i inställningarna.
- En dokumentmatare med 50 ark ska klaras i ett svep. Gränsen per uppladdning sätts till 200 sidor.
- **Internet krävs.** Ingen offline-läsning.
- iOS-appen byter till svenska, så att den följer webbprogrammet.
- Bildutklippen blir bra men inte felfria. Därför finns manuell justering med i MVP.
- Tjänsten publiceras via Emergents "Publish". Det medför en löpande hostingkostnad.
- Gamla scanningar som finns lokalt i iPhone-appen flyttas inte över till servern. De finns kvar i telefonen men syns inte i det nya arkivet.
- Scanning direkt från skrivaren till servern ("Scanna till e-post") byggs inte. Skälet är att material bara ska kunna komma in via webb eller iOS. Home Assistant, NAPS2-skript och skriptnycklar är strukna.
- CopyThat tar inte emot något via e-post. E-post används bara för att skicka inloggningskoder.
- Det här dokumentet är fristående och får publiceras på GitHub. Det innehåller inga nycklar eller hemligheter.
