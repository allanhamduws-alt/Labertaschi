# Release & Auto-Update — Anleitung

## Release auslösen (DMG bauen lassen)

Die GitHub Action `build-release.yml` baut Mac (DMG + ZIP) und Windows und legt
ein GitHub-Release an, sobald ein Tag `v*` gepusht wird:

```bash
cd ~/Vibe/paply-main
git push origin main          # Code hochladen
git tag v1.8.0                 # Version-Tag (muss zur package.json-Version passen)
git push origin v1.8.0         # löst die Action aus
```

Danach: GitHub → Actions beobachten. Nach Erfolg liegt das Release unter
`github.com/qode-lab-wtf/paply/releases` mit `.dmg`, `.zip`, `latest-mac.yml`.

## Zwei Wege, das Update zu bekommen

### A) DMG-Download (funktioniert immer, auch unsigniert)
1. DMG aus dem Release herunterladen.
2. Alte App in den Papierkorb, neue aus dem DMG nach `/Programme`.
3. Beim ersten Start (unsigniert): Rechtsklick auf die App → **Öffnen** → **Öffnen**
   (umgeht Gatekeeper). Oder: Systemeinstellungen → Datenschutz & Sicherheit → „Trotzdem öffnen".

### B) In-App-Auto-Update (nur mit Signierung + Notarisierung)
Funktioniert **nur**, wenn die App mit einem Apple **Developer-ID-Zertifikat**
signiert und notarisiert ist. Voraussetzungen (Apple Developer Account nötig):

1. **Zertifikat erstellen:** Apple Developer Portal → *Certificates, IDs & Profiles*
   → Certificates → **Developer ID Application** erstellen, herunterladen, in die
   Keychain importieren.
2. **Als `.p12` exportieren:** Schlüsselbund → das Zertifikat (mit privatem Schlüssel)
   → Rechtsklick → „Exportieren" → `.p12` mit Passwort.
3. **In Base64 wandeln:** `base64 -i zertifikat.p12 | pbcopy`
4. **GitHub Secrets setzen** (Repo → Settings → Secrets and variables → Actions):
   - `CSC_LINK` = der Base64-String aus Schritt 3
   - `CSC_KEY_PASSWORD` = das `.p12`-Passwort
   - `APPLE_ID` = deine Apple-ID-E-Mail
   - `APPLE_APP_SPECIFIC_PASSWORD` = ein App-spezifisches Passwort (appleid.apple.com → Anmeldung & Sicherheit)
   - `APPLE_TEAM_ID` = deine Team-ID (Developer-Portal → Membership)

Sind diese Secrets gesetzt, baut die Action automatisch signiert + notarisiert →
das In-App-Auto-Update funktioniert. Fehlen sie, baut sie sauber unsigniert (nur DMG).

## macOS-Berechtigung „Systemaudioaufnahme" (für den Meeting-Recorder!)

Der Meeting-Recorder nimmt System-Audio über Apple Core Audio Taps auf. Ohne
erteilte Berechtigung zeichnet er **lautlos Stille** auf (ohne Fehlermeldung).

**Beim ersten Meeting (`Cmd+Shift+X` während ein Call läuft)** sollte macOS nach der
Berechtigung fragen. Falls nicht / falls das System-Pünktchen gelb bleibt:

> Systemeinstellungen → **Datenschutz & Sicherheit** → **Bildschirm- & Systemaudioaufnahme**
> → Abschnitt **„Nur Systemaudioaufnahme"** → die App (bzw. „paply"/„Electron") aktivieren
> → App neu starten.

Im **Overlay** zeigt der **blaue Pegelbalken** an, ob System-Audio ankommt — bewegt
er sich, ist alles korrekt; bleibt er flach + Punkt wird gelb, fehlt die Berechtigung
oder der Anruf läuft nicht über den Mac.
