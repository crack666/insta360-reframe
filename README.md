# insta360-reframe

Equirect-MP4 (MediaSDK-Stitch) → **flaches** 16:9-Video mit Richtungs-Presets, Timeline-Cuts und interaktivem Editor.

Ziel: Chest-Mount / Action-Clips ohne Insta360 Studio reframen — Preview im Browser, Export über ffmpeg.

---

## Pipeline

```
.insv  →  MediaSDK stitch  →  equirect.mp4  →  [Editor]  →  flat.mp4
                              (360° Kugel)     Cuts/FOV      (normales Video)
```

1. **MediaSDK** liefert Equirect (Kugelkarte).
2. **Preview** (Three.js) lässt dich Blickrichtung, FOV und Timeline kalibrieren.
3. **Export** (ffmpeg `v360`) rendert dieselbe Timeline als flaches MP4.

---

## Preview / Editor

```bash
npm run preview -- --video "D:/path/to/equirect.mp4"
# → http://127.0.0.1:8787/
```

### Workflow

1. **Presets kalibrieren** (einmal pro Mount) — Winkel speichern → `presets.json`
2. **Cuts setzen** — Playhead + `C` / `X` (custom) / Buttons / Peek
3. **Optional:** Segment am Playhead **updaten** (`U`) ohne neuen Cut
4. **Optional analysieren** — Ruhe / Selfie-Check / Spikes → übernehmen oder verwerfen
5. **Timeline** speichern (Auto-Save nach Cuts) → `<video>.timeline.json` + `.timeline.txt`
6. **Export Flat** im Panel (Auflösung / Codec / Qualität) — oder CLI

### Shortcuts

| Taste | Aktion |
|---|---|
| Space | Play / Pause |
| C | Cut → aktives Preset |
| X | Cut → custom (aktueller Blick, grau) |
| U | Segment am Playhead überschreiben (Blick + Lens) |
| F / S | Cut → forward / selfie |
| 1 / 2 / 4 | Tempo |
| [ / ] | ±5 s |
| Del | Cut am Playhead entfernen |

Peek-Streifen: Live-Vergleich forward · selfie · left · right.

### View Angle Gear (Lens)

| Gear | Wirkung |
|---|---|
| Default | H-FOV aus Preset / Custom (~120°) |
| Linear | enger (~95°) |
| Ultra | weiter (~140°) |

Nur Zoom — Richtung (Yaw/Pitch) bleibt. Wird pro Segment gespeichert (`+linear` / `+ultra` in der Timeline).

---

## Export

### UI

Panel **„4 · Export Flat“**: Auflösung (720p / 1080p / 1440p), Codec (H.264 / H.265), Qualität (Draft / Medium / High), optional Bitrate + Pfad.

Speichert zuerst die Timeline, rendert dann asynchron (Fortschrittsbalken + Log).

### CLI

```bash
node src/cli.mjs -i stitch.mp4 -o flat.mp4
node src/cli.mjs -i stitch.mp4 -o flat.mp4 -t "0-12=forward,12-22=selfie,22-end=forward"
node src/cli.mjs -i stitch.mp4 -o flat.mp4 --width 1920 --height 1080 --codec hevc --quality high
node src/cli.mjs --list-encoders
```

Ohne `-t` / `--timeline-file` lädt die CLI automatisch `<input>.timeline.json` (falls vorhanden).

| Option | Default | Bedeutung |
|---|---|---|
| `--width` / `--height` | 1920×1080 | Flat-Auflösung |
| `--codec` | `h264` | `h264` oder `hevc` (H.265) |
| `--quality` | `medium` | `draft` / `medium` / `high` (CQ/CRF) |
| `--bitrate` | — | z.B. `8M` — überschreibt Qualität |
| `--audio-bitrate` | `160k` | AAC |

Encoder-Wahl: NVENC wenn verfügbar (`h264_nvenc` / `hevc_nvenc`), sonst `libx264` / `libx265`.

---

## Preview vs. Export: Three.js ≠ ffmpeg

Beide lesen dieselben **UI-Winkel** und dieselbe Timeline — aber die Kameramodelle sind unterschiedlich. Die Brücke steckt in `src/presets.mjs` (`toFfmpegView`, `hfovToVfov`, `v360Filter`).

### Zwei Welten

| | **Preview (Three.js)** | **Export (ffmpeg `v360`)** |
|---|---|---|
| Zweck | Interaktiv, Echtzeit | Pixelgenaues Flat-MP4 |
| Input | Equirect als Textur-Kugel | Equirect-Datei + Filtergraph |
| Blick | `PerspectiveCamera` auf invertierter Sphere | `v360=input=e:output=flat` |
| Yaw in der UI | Quelle der Wahrheit (Presets / Cuts) | UI-Yaw **+ 90°** vor dem Filter |
| FOV | UI speichert **H-FOV**; Camera bekommt daraus berechnetes **V-FOV** | ebenfalls H-FOV → V-FOV aus Aspect (`w/h`) |
| Aspect | Viewport / Peek-Canvas | Export-`--width` × `--height` |

### 1) Yaw-Offset (+90°)

Im Preview steckt die Equirect-Textur auf einer **invertierten** Kugel; die Kamera rotiert mit `rotation.y = -yaw` (UI-Konvention).

ffmpeg `v360` mit `yaw=0` zeigt auf die **Equirect-Mitte** — das ist nicht dieselbe Nullrichtung wie die Three.js-Szene.

**Finding:** Ohne Korrektur wirkte „forward“ im Preview wie „links“ im Export.

```js
// src/presets.mjs — toFfmpegView()
yaw_ffmpeg = normalize(yaw_ui + 90)
```

Pitch/Roll bleiben 1:1. Niemals UI-Yaw direkt in den Filter schreiben.

### 2) H-FOV ist Quelle der Wahrheit

Three.js `PerspectiveCamera.fov` ist **vertikal**. Früher wurde UI-`h_fov` fälschlich 1:1 als Camera-FOV gesetzt → Preview und Export hatten unterschiedlichen Zoom.

Jetzt (Preview + Export):

```
v_fov = 2 * atan( tan(h_fov/2) / aspect )
```

`aspect = width/height` (Export) bzw. Canvas-Aspect (Preview). Gespeichertes Legacy-`v_fov` in Presets wird beim Rendern **ignoriert**, damit kein Mismatch entsteht.

### 3) Was du kalibrieren sollst

Kalibriere immer im **Preview** (was du siehst). Export übernimmt automatisch Offset + FOV-Umwandlung. Wenn Preview und Flat-Datei auseinanderlaufen: zuerst prüfen, ob alter Export vor dem Yaw/FOV-Fix stammt — neu exportieren.

```
UI / presets.json / timeline
        │
        ├─► Three.js  (yaw_ui, h_fov → vfov(aspect_preview))
        │
        └─► ffmpeg    (yaw_ui+90, h_fov → vfov(aspect_export))
```

---

## Datenformate

### `presets.json`

Gemeinsame Quelle für Preview und CLI. Felder pro Preset: `yaw`, `pitch`, `roll`, `h_fov`, `label`.

### Timeline

Companion-Dateien neben dem Video:

- `<video>.timeline.json` — Segmente + Rohstring
- `<video>.timeline.txt` — eine Zeile / CSV-ähnlich

Beispiele:

```
0-12=forward,12-22=selfie+linear,22-end=forward
0-5=custom@-86/12/120,5-end=forward+ultra
```

Custom: `custom@yaw/pitch/h_fov`. Lens-Suffix: `+linear` / `+ultra`.

---

## Architektur (kurz)

| Modul | Rolle |
|---|---|
| `preview/` | Editor-UI (Three.js Equirect-Viewer) |
| `src/preview-server.mjs` | Statik + APIs (Presets, Timeline, Suggest, Export) |
| `src/presets.mjs` | Presets, Lens-Gears, **ffmpeg↔UI-Brücke** |
| `src/timeline.mjs` | Parse / Serialize / Resolve |
| `src/suggest.mjs` | Semi-auto Vorschläge (Ruhe, Hautfarbe, Spikes) |
| `src/ffmpeg.mjs` | Probe, Encoder-Wahl, Segment-Encode, Concat |
| `src/export.mjs` | Shared Export (CLI + `/api/export`) |
| `src/cli.mjs` | CLI-Frontend |

---

## Roadmap (Produktiv-Workflow + UI)

Proxy-Stitch → Editor → Final (Temp-Master) als Wizard in derselben Web-App:  
[`docs/WORKFLOW_UI_PLAN.md`](docs/WORKFLOW_UI_PLAN.md)

### Project CLI (Phase 1)

```bash
npm run project -- list-inbox
npm run project -- create-project my-run
npm run project -- add-take-from-inbox my-run --take 011
npm run project -- stitch-proxy my-run 011          # MediaSDK Docker (lang)
# Dev-Smoke ohne Full-Stitch:
npm run project -- set-proxy my-run 011 --file path/to/equirect.mp4
npm run project -- import-timeline my-run 011 --from path/to.timeline.json
npm run project -- final my-run 011 --use-proxy-as-master
# Echter Final (Master-Stitch temp → Flat → Master löschen):
npm run project -- final my-run 011
```

## Not in scope

- Studio Deep Track / vollauto Körper-Tracking
- Dual-Fisheye / Roh-`.insv` (nur Equirect-Input)
- Identisches Studio-Look (Projection „feel“ weicht leicht ab; Gear-Namen sind Annäherung)
