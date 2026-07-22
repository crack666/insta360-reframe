# insta360-reframe

Equirect (MediaSDK-Stitch) → **flat** MP4 with direction presets + interactive editor.

## Preview / Editor

```bash
npm run preview -- --video "D:/ai/ai-stack/data/insta360/work/011-reframe-smoke/equirect_40s.mp4"
# → http://127.0.0.1:8787/
```

### Workflow

1. **Presets kalibrieren** (einmal pro Mount) — Winkel speichern → `presets.json`
2. **Cuts setzen** — Playhead + `C` / Buttons / Peek-Klick = ab hier dieses Preset
3. **Optional analysieren** — Pausen → Selfie-Vorschläge, Spikes als Marker → übernehmen/verwerfen
4. **Timeline speichern** → `*.timeline.json` neben dem Video · CLI kopieren · exportieren

### Shortcuts

| Taste | Aktion |
|---|---|
| Space | Play / Pause |
| C | Cut → aktives Preset |
| F / S | Cut → forward / selfie |
| 1 / 2 / 4 | Tempo |
| [ / ] | ±5 s |
| Del | Cut am Playhead entfernen |

Peek-Streifen unten: Live-Vergleich forward · selfie · left · right (Klick = Cut).

## Export

```bash
node src/cli.mjs -i stitch.mp4 -o flat.mp4 -p forward
node src/cli.mjs -i stitch.mp4 -o flat.mp4 -t "0-12=forward,12-22=selfie,22-end=forward"
# oder Timeline-Datei:
node src/cli.mjs -i stitch.mp4 -o flat.mp4 --timeline-file stitch.mp4.timeline.txt
```

`presets.json` und die Editor-Timeline teilen sich CLI und Preview.

## Pipeline

1. MediaSDK: `.insv` → equirect MP4  
2. Preview: Presets + Cuts + optional Suggestions  
3. CLI: equirect → flat  

## Not in scope

- Studio Deep Track / vollauto Körper-Tracking
