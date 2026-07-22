# Plan: Produktiv-Workflow + UI (Proxy → Editor → Final)

> **Status:** Entwurf zum sequenziellen Abarbeiten  
> **Repo:** `insta360-reframe` (+ MediaSDK in `ai-stack`)  
> **Stand:** 2026-07-23  
> **Ziel:** Vom Roh-`.insv` bis Flat-Deliverable ohne CLI/README-Pflicht — LLM/CLI bleiben Dev-Pfad.

---

## 0. Produktentscheidung (UI)

### Empfehlung: **eine Web-App, Wizard + bestehender Editor**

| Option | Urteil |
|---|---|
| **A. Alles in der bestehenden Web-UI** (Wizard-Seiten + Preview) | **Empfohlen** |
| B. Extra Python-GUI nur für Stitch/Final | Zweiter Stack, Preview trotzdem Browser |
| C. Zwei getrennte Web-UIs | Mehr Deploy/Auth/Port-Chaos ohne Nutzen |

**Warum A**

- Preview-Editor ist schon Web + gut nutzbar — Einstieg erweitern, nicht ersetzen.
- Lange Jobs (Stitch) brauchen Fortschritt/Polling — HTTP-API existiert schon (`/api/export/*`).
- Ein Tab, ein Port (`8787`), ein Look.
- CLI bleibt parallel für Tests/OpenClaw; UI ruft dieselben Runner auf.

**UX-Prinzip:** Der User sieht **Projekte / Takes**, nie „ffmpeg“ oder Docker-Flags. Fortschritt in Alltagssprache: *„Stitch läuft… 40 %“*, *„Proxy bereit — Editor öffnen“*, *„Final rendern“*.

**Nicht jetzt:** Deep Track, Studio-Automation, echtes Raw→Flat ohne Equirect-Zwischenpass.

---

## 1. Zielbild (User Journey)

```
[Start]
   │
   ▼
① Projekt / Session anlegen   („Lauf 2026-07-22“)
   │
   ▼
② Raw-Dateien wählen + Reihenfolge (Drag&Drop / Inbox-Picker)
   │    → Auto-Gruppierung *_00_* + *_10_* zu einem Take
   │
   ▼
③ Proxy erzeugen (ein Klick)   → warten mit Fortschritt
   │
   ▼
④ Editor (bestehendes Preview) → Timeline, Presets, Cuts
   │    → Auto-Save Timeline + Manifest
   │
   ▼
⑤ Final rendern (Qualität wählen)
   │    → Master-Equirect TEMP → Flat → Temp löschen
   │
   ▼
⑥ Fertig: Flat in out/ + Archiv-Artefakte (Timeline, Manifest)
```

**Dauerhaft behalten:** Raw (inbox), Manifest, Timeline, Flat(s), Presets.  
**Temp:** Proxy optional behalten (schnell wieder öffnen), Master-Equirect nach Final löschen.

---

## 2. Datenmodell (Kern)

Alles unter z.B. `data/insta360/projects/<project-id>/`:

```
projects/
  2026-07-22-obstacle/
    project.json          # Session-Metadaten, Take-Reihenfolge
    takes/
      011/
        take.json         # Manifest (siehe unten)
        proxy/
          equirect.mp4
        timeline/
          timeline.json   # portabel (nicht nur neben einer MP4)
          timeline.txt
        final/
          flat.mp4
        work/             # temp Master-Equirect, segment workdirs
    out/                  # optionale Copies / Session-Concat
```

### `take.json` (Minimum)

```json
{
  "id": "011",
  "label": "Take 011",
  "raw": ["…/VID_…_00_011.insv"],
  "status": "proxy_ready",
  "proxy": { "path": "…/proxy/equirect.mp4", "width": 1920, "height": 960 },
  "timeline": { "path": "…/timeline/timeline.json" },
  "final": {
    "path": "…/final/flat.mp4",
    "width": 1920,
    "height": 1080,
    "codec": "h264",
    "quality": "high"
  },
  "stitch": {
    "flowstate": true,
    "directionLock": true,
    "proxyOutputSize": "1920x960",
    "finalOutputSize": "3840x1920"
  }
}
```

`status`: `draft` → `stitching_proxy` → `proxy_ready` → `editing` → `rendering_final` → `done` | `error`

### `project.json`

- Name, created, take-IDs **in Abspielreihenfolge**
- Option: `concatFinals: true` → nach allen Takes ein Session-MP4

---

## 3. Architektur (eine App, klare Schichten)

```
┌─────────────────────────────────────────────┐
│  Web UI                                      │
│  /           Wizard / Projektliste           │
│  /project/:id                                │
│  /project/:id/take/:tid/edit  → Preview     │
└─────────────────┬───────────────────────────┘
                  │ HTTP API
┌─────────────────▼───────────────────────────┐
│  Node preview-server (erweitert)             │
│  projects · jobs · stitch-bridge · export    │
└───────┬─────────────────────────┬───────────┘
        │                         │
        ▼                         ▼
  MediaSDK (Docker)         exportFlat() / ffmpeg
  stitch proxy|final        v360 + Timeline
```

- **UI** spricht nur API.
- **Stitch-Bridge:** startet Docker/`MediaSDKTest`, parst Logs → Progress, schreibt Proxy/Temp-Master.
- **Export:** bestehendes `export.mjs` (Timeline + Flat-Settings).
- **CLI** optional: `node src/cli-project.mjs final --take 011` ruft dieselbe Bridge auf (LLM/Dev).

---

## 4. Phasen (sequenziell abarbeiten)

Legende: `[ ]` offen · `[~]` teilweise · `[x]` erledigt

---

### Phase 0 — Fundament & Entscheidungen festnageln

**Ziel:** Ohne UI schon denselben Datenvertrag.

- [x] `docs/WORKFLOW_UI_PLAN.md` + Pfade an `ai-stack/data/insta360`
- [x] Projekt-Root Default `…/projects` (`INSTA360_ROOT`)
- [x] Schema `project.json` + `take.json` (`docs/schema/*.example.json`)
- [x] Status-Enum + Fehlerfeld
- [x] README verweist auf Plan + Project CLI

**Exit:** Schema steht; Beispiel-Manifeste + live `projects/smoke-011`.

---

### Phase 1 — Runner ohne UI (CLI/Dev, gleiche Logik wie später UI)

**Ziel:** Proxy-Stitch + Final-Pipeline einmal skriptbar; UI wird dünn.

- [x] Modul `src/project.mjs` — load/save Manifest, Pfade auflösen
- [x] Modul `src/stitch.mjs` — MediaSDK Docker (proxy | final)
- [ ] Modul `src/jobs.mjs` — Job-Queue in-process (mit Phase 2 API nachziehen)
- [x] `project-cli`: create-project, add-take-from-inbox, stitch-proxy, final, …
- [x] `final` = stitch master temp → `exportFlat` → delete master (`--keep-master` optional)
- [x] Timeline unter `takes/…/timeline/` (`import-timeline`; Editor-Sync = Phase 3)
- [x] Smoke: `final --use-proxy-as-master` (ohne Full-Stitch)
- [ ] Optional: echter MediaSDK `stitch-proxy` / Full-`final` auf Take 011

**Exit (erreicht für Dev-Pfad):** Take ohne Browser finalisierbar (Proxy-als-Master). Echter Master-Stitch = langer GPU-Lauf, separat verifizieren.

---

### Phase 2 — Wizard Web-UI (vor dem Editor)

**Ziel:** User braucht keine CLI für Schritte ①–③.

- [ ] Routes/Pages: Start → Neues Projekt → Takes hinzufügen
- [ ] Inbox-Browser (Server listet `inbox/**/*.insv`)
- [ ] Auto-Pair `00`/`10`; manuelle Reihenfolge (↑↓)
- [ ] Button „Proxy erzeugen“ + Progress (Poll `/api/jobs/:id`)
- [ ] Bei `proxy_ready`: Button „Im Editor öffnen“
- [ ] Fehlerzustände verständlich (GPU/Docker down, fehlende Paar-Datei)

**Exit:** Komplett untrainierter Ablauf: Dateien wählen → warten → Editor.

---

### Phase 3 — Editor an Projekt anbinden

**Ziel:** Preview ist kein „loses Video“, sondern Take-Kontext.

- [ ] Preview-Server startet mit `--project` / Take-ID **oder** UI navigiert zu `/edit?take=`
- [ ] Video-Quelle = Proxy-Pfad aus Manifest
- [ ] Timeline lesen/schreiben über Take-Pfade (nicht nur `<video>.timeline.json`)
- [ ] Header: Projektname · Take · Status · „Zurück zur Übersicht“
- [ ] Bestehende Export-Panel-Defaults aus `take.json.final` vorbefüllen
- [ ] Optional: „Nur Timeline speichern“ vs. „Final rendern“ klar trennen (Final = Wizard-Schritt oder großer Button mit Confirm)

**Exit:** Editor fühlt sich wie Schritt ④ derselben App an.

---

### Phase 4 — Final-UX + Aufräumen

**Ziel:** Ein Klick „Final“, klare Artefakte.

- [ ] Dialog: Auflösung / Codec / Qualität (wie jetzt), Ausgabe `takes/…/final/`
- [ ] Progress: Stitch Master (lang) → Reframe Segmente → Aufräumen
- [ ] Checkbox: „Proxy behalten“ (default an) / „Master-Equirect behalten“ (default aus)
- [ ] Nach Done: Link „Ordner öffnen“ / Pfad kopieren
- [ ] Archiv-Policy UI-Text: *Gespeichert: Timeline + Flat + Manifest. Raw unverändert in inbox.*

**Exit:** Produktiv-Take ohne Terminal final; Platte ohne 90‑GB-Master.

---

### Phase 5 — Session / Mehrere Takes

**Ziel:** „Ein Lauf = mehrere Takes“.

- [ ] Projekt-Übersicht: Take-Liste, Status-Badges, Reorder
- [ ] „Alle Proxies erzeugen“ / „Alle Finals“
- [ ] Optional: Session-Concat der Flats in Reihenfolge → `out/session.mp4`
- [ ] Skip/Retry einzelner Takes

**Exit:** Multi-Take-Session ohne manuelles Concat-CLI.

---

### Phase 6 — Polish & Robustheit

- [ ] Resume nach Abbruch (Job-State auf Disk)
- [ ] Speicherwarnung vor Final (Schätzung Proxy/Master/Flat)
- [ ] Einfache Settings-Seite: Inbox-Pfad, Projects-Pfad, Docker-Image-Name
- [ ] Telemetrie-light: Dauer Stitch/Export im Manifest fürs nächste Mal
- [ ] Optional später: OpenClaw-Skill ruft dieselben Job-APIs auf

---

## 5. Usability-Guidelines (für alle Phasen)

1. **Ein Primär-CTA pro Screen** — nicht fünf gleichwertige Buttons.
2. **Fachjargon vermeiden** — „Zwischenvideo (Proxy)“ statt „Equirect 1920×960“.
3. **Fortschritt ehrlich** — bei unbekanntem SDK-Progress zumindest Phase + Zeit laufend.
4. **Zerstörerisches bestätigen** — Final überschreiben, Temp behalten, Projekt löschen.
5. **CLI nie Voraussetzung** — höchstens „Erweitert / für Automation“ einklappbar.
6. **Editor nicht überladen** — Wizard = Dateien & Jobs; Editor = Blick & Cuts.

---

## 6. Abgrenzung / Non-Goals (diese Roadmap)

- Insta360 Studio Deep Track / Shot Lab
- Preview direkt auf 90‑GB-Master
- `.insv` im Three.js-Viewer
- Windows-native MediaSDK-GUI
- Python-Parallel-UI

---

## 6b. Backlog (später, kein Core)

### Cut-Transitions (ohne Micro-Segmente)

**Idee:** Harte Cuts bleiben die gespeicherte Wahrheit. Optional am Segmentwechsel eine Transition-Dauer; Export/Preview interpoliert Yaw/Pitch/FOV über T Sekunden selbst — **keine** Micro-Segmente in Timeline/Manifest.

```
…12=forward | 12-22=selfie…
              └ transition: ~0.4s  (Render-Ableitung, nicht Timeline-Inhalt)
```

**Warum später:** Workflow/Proxy/Final/UI sind wichtiger; Preview muss dasselbe Interpolationsmodell wie ffmpeg nutzen (sonst wieder Mismatch). Regeln für kurze Segmente + lange Transition erst dann festnageln.

**Nicht tun:** Transition als 10–30 Micro-Cuts materialisieren und speichern.

---

## 7. Reihenfolge der Umsetzung (Kurz)

| # | Phase | Liefert |
|---|---|---|
| 0 | Schema | Vertrag |
| 1 | Runner/CLI | Beweis Final-ohne-Master-Archiv |
| 2 | Wizard UI | Dateien → Proxy ohne Terminal |
| 3 | Editor-Bindung | Eine App |
| 4 | Final-UX | Produktiv-Klick |
| 5 | Multi-Take | Session |
| 6 | Polish | Alltagshärtung |

**Nächster konkreter Schritt nach Plan-Freigabe:** Phase 0+1 (Schema + `stitch-proxy` / `final` Runner), parallel schon Wizard-Wireframes skizzieren — UI erst, wenn Runner grün ist, sonst Progress-Lügen.

---

## 8. Offene Punkte / Phase-0-Entscheidungen

| # | Frage | Entscheidung (2026-07-23) |
|---|---|---|
| 1 | Proxy-Default | **`1920x960`** (Editor-tauglich; kleiner später als Preset) |
| 2 | Final Equirect | Heuristik **`max(3840x1920, ~2× Flat-Breite)`**, überschreibbar in `take.json` |
| 3 | Projekt-Root | Default **`data/insta360/projects`** (`INSTA360_ROOT`); UI-wahl später |
| 4 | Lange Jobs | Zuerst **in-process Job** wie Export; eigener Worker erst bei Bedarf |

### Umsetzungsstand

- [x] Plan + Transitions-Backlog
- [x] Phase 0 Schema (`docs/schema/*.example.json`, `src/project.mjs`)
- [x] Phase 1 Runner (`stitch.mjs`, `final.mjs`, `project-cli.mjs`) — UI folgt Phase 2
- [x] Phase 1 Smoke: `final --use-proxy-as-master` auf Take 011 → `projects/smoke-011/…/final/flat.mp4`
- [ ] Phase 1 optional: echter `stitch-proxy` / `final` (voller MediaSDK-Lauf)
- [ ] Phase 2+ UI

---

## 9. Entscheidungslog (UI)

**Gewählt:** Integrierte Web-UI (Wizard + Preview), eine Codebase, Job-API teilt sich mit CLI.

**Verworfen für v1:** Python-GUI, separate zweite Webapp.
