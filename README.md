# insta360-reframe

Equirect (MediaSDK-Stitch) → **flat** MP4 with direction presets for chest-mount jogging / obstacle courses.

## Presets

| Name | Intent | Default yaw / pitch |
|---|---|---|
| `forward` | Trail ahead | 0 / -8° |
| `selfie` | Wearer face (chest mount) | **180** / +35° |
| `up` | Zenith / sky | 0 / +55° |
| `left` / `right` | Side glance | ±90° / -5° |
| `back` | Behind at horizon | 180° / -5° |

Calibrate once per mount: dump stills with `--yaw/--pitch` overrides. Chest-mount “selfie” is typically **look back + slightly up**, not straight zenith.

## Interactive preview (no full re-render)

Browse the equirect, drag to look, try presets, mark timeline segments, copy a CLI command — then render once.

```bash
# Prefer a short proxy (e.g. work/011-reframe-smoke/equirect_40s.mp4), not the 3GB full stitch
npm run preview -- --video "D:/ai/ai-stack/data/insta360/work/011-reframe-smoke/equirect_40s.mp4"
# → http://127.0.0.1:8787/
```

- Drag = look · Scroll = FOV · Preset buttons = same angles as CLI
- **Mark In / Mark Out + Add** builds a timeline string → **Copy CLI cmd**

# Timeline (obstacle highlight = selfie, else forward)
node src/cli.mjs -i stitch.mp4 -o flat.mp4 \
  -t "0:00-3:00=forward,3:00-3:25=selfie,3:25-end=forward"

node src/cli.mjs --list-presets
```

Requires `ffmpeg` / `ffprobe` on PATH (uses `h264_nvenc` when available).

## Pipeline

1. MediaSDK: `.insv` → equirect MP4 (`enable_flowstate` + `enable_directionlock`)
2. **This tool:** equirect → flat with presets / timeline
3. Optional later: face-assist only on marked segments (not required for v0.1)

## Not in scope (v0.1)

- Studio Deep Track / Project XML
- Automatic person tracking for the whole clip
