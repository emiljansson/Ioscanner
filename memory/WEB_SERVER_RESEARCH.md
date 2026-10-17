# Utredning: Serverbaserad webbversion av CopyThat (juni 2026)
Status: ENDAST UTREDNING – inget byggt. Användaren svarar på svenska.

## Användarens önskemål
- Helt serverbaserad: backend håller alla API-nycklar m.m.
- Ingen kamera på webben: ladda in valfria bilder, eller använda scanner.
- Bilder/figurer i materialet ska klippas ut och läggas in i samma dokument (eller zip för nedladdning).
- Bred responsiv layout för dator. Scanningar sparas med bilder.

## Föreslagen arkitektur
- FastAPI-backend + MongoDB + Emergent Object Storage (bilder/filer).
- API-nycklar (OpenAI/Gemini/Anthropic) i backend (.env), aldrig i klienten.
- Inloggning krävs (annars kan vem som helst använda nycklarna/krediterna).
- Port av ai.ts (prompter, consensus), confidence.js, textCleanup.js, errorMessages.js till Python
  (all logik är ren, inga Expo-beroenden) – se src/lib/ai.ts:43-757.
- Webbfrontend = samma Expo-kodbas (Expo web), iOS-appen kan peka mot samma backend.

## Inmatning
- Uppladdning: JPG/PNG/HEIC/WebP/TIFF + flersidiga PDF (PyMuPDF renderar sidor). Drag & drop, flera filer.
- Scanner: webbläsare kan inte prata direkt med scanner.
  a) Scanna till fil (scannerns program / Windows Faxa och skanna / macOS Digitalisera / iPhone Filer->Skanna) och dra in – gratis.
  b) Scan-to-email: scanner mejlar till unik adress -> backend tar emot (inbound mail-tjänst).
  c) Direkt scannerstyrning i webbläsaren: kräver lokalt program + betald SDK (Dynamic Web TWAIN, VintaSoft) – avråds.
  d) iOS: VisionKit-dokumentscanner (kantdetektering) – kräver native build.

## Bildutklipp
- PDF med inbäddade bilder: PyMuPDF extraherar originalbilder direkt.
- Foto/scannade sidor: Gemini returnerar bounding boxes (box_2d [ymin,xmin,ymax,xmax] 0-1000) för foton/diagram/logotyper
  -> backend klipper ut i full upplösning med Pillow -> placeras på rätt plats i texten.
- Alternativ: lokal layoutmodell (DocLayout-YOLO / PaddleOCR PP-Structure) – gratis per anrop men tyngre server.

## Utdata
- DOCX (Word) med rubriker + bilder på rätt plats (python-docx), PDF, ZIP (docx + txt + mapp med bilder).

## Användarens beslut (runda 2)
- Användare: bara ägaren + fåtal, med inloggning. Inloggning: "e-post med pinkod" (oklart: engångskod via mejl eller fast PIN – fråga).
- iOS-appen ska gå via servern (gemensamt arkiv).
- Scanner: A (fil + dra in) + C (direkt scannerstyrning). Användaren frågade varför C kostar.
- Utdata: Word (.docx) med bilder + ZIP.

## Scanner – gratisalternativ till betald SDK (Dynamic Web TWAIN ca 1 250 USD/år)
- NAPS2 WebScan (öppen källkod, lokal Windows-tjänst som exponerar scanner via eSCL) + NAPS2.Sdk.
- ScanBridge (MIT, Windows-tray kring NAPS2, lokalt HTTP-API).
- AmbirScan Web Connect (MIT-SDK, men runtime gratis främst för Ambir-scanners).
- eSCL/AirScan-nätverksscanner direkt: blockeras av webbläsaren (HTTPS-sida -> http på lokalt nät) => kräver tillägg/hjälpprogram.
- scanservjs (GPL, Linux/Raspberry Pi med SANE) – scanner delas på nätet.

## Användarens beslut (runda 3)
- Windows-dator + wifi-nätverksscanner/multifunktionsskrivare -> NAPS2/ScanBridge (eSCL/WIA) är rätt väg för C.
- Inloggning: engångskod via e-post (Emergent-hanterad Resend, ingen nyckel behövs).
- Fortfarande utredning – användaren bad om krav + omfattning (levererat i chatten).

## Scanner via Home Assistant (runda 4)
- Användarens scanner: HP Color LaserJet Pro MFP 3302 (WIA + eSCL/AirScan, ADF 50 ark, duplex). Testad OK med NAPS2 på Windows.
- Användaren vill ha scannermotorn på sin Home Assistant i stället för Windows.
- Förslag: egen HA-add-on "CopyThat Scanner" (Docker + Python) som pratar eSCL direkt med HP:n (HTTP på lokalt nät),
  kopplar UT mot CopyThat-servern (ingen portöppning), hämtar scanjobb, scannar ADF/duplex, laddar upp sidor.
  Trigger: Scanna-knapp i webb/iOS, HA-dashboardknapp/automation.
- Befintliga alternativ: scanservjs-add-on (magicx78/ha-scanservjs-addon, sane-airscan), ha-escl-scan (wleonhardt, HACS).
- Ersätter fas 5 (ScanBridge) om användaren väljer det.

## Produktmål (runda 5)
- Webbprogram = huvudprodukt (iOS = komplement, samma server/arkiv).
- Flöde: in (HA-scanner/upload) -> AI-OCR -> digitalt dokument (redigerbart, sökbart arkiv) -> bearbeta med FRI AI-instruktion.
- Material: kurs- och studiematerial. Utdata: Word (.docx) med bilder + ZIP.

## Kurs-/studiematerial – särskilda krav
- Matteformler: OCR till LaTeX -> Word-ekvationer (OMML) via Pandoc (Markdown+LaTeX+bilder -> .docx med äkta ekvationer, rubriker, tabeller).
- Tabeller -> riktiga Word-tabeller. Diagram/figurer -> utklippta bilder med bildtext.
- Flerspaltig layout, sidhuvud/sidfot/sidnummer bort, markeringar/understrykningar, handskrivna anteckningar i marginal (flagga).
- Dokumentstruktur: Kurs -> Dokument -> Sidor (sidordning via befintlig ORGANIZE-logik).
- Fri AI-instruktion på valda sidor/hela dokument/flera dokument; resultat = nytt dokument (versioner, original orört).
  Sparade egna instruktionsmallar. Långa dokument: modeller med stor kontext (Gemini) eller kapitelvis bearbetning.

## NAPS2 som motor (runda 6)
- NAPS2 har inget REST-API, men NAPS2.Console.exe (CLI) + .NET SDK + "Scanner Sharing" (eSCL-server, 8.2+ även med NAPS2 stängt).
- CLI: naps2.console -o out.pdf --noprofile --driver wia|escl --device "3302" --source duplex --dpi 300 -f
- Förslag: PowerShell-skript scan -> curl.exe upload till CopyThat /api med personlig API-token.
  Trigger: genväg/snabbtangent, Aktivitetsschemaläggaren, eller Home Assistant via HASS.Agent (kör kommando på Windows).
- Kräver i CopyThat: uppladdnings-endpoint + personliga API-tokens (fas 1/2).

## Faser (förslag)
1. Backend + inloggning + servernycklar + porterad AI-logik
2. Webb-UI: uppladdning (bilder + PDF), bred layout, historik
3. Bildutklipp + DOCX/PDF/ZIP-export
4. iOS-appen mot backend (gemensamt arkiv)
5. (Valfritt) Scan-to-email
