# insta360-reframe

Equirect (MediaSDK-Stitch) → **flat** MP4 with direction presets + interactive preview.

## Interactive preview

```bash
npm run preview -- --video "D:/ai/ai-stack/data/insta360/work/011-reframe-smoke/equirect_40s.mp4"
# → http://127.0.0.1:8787/
```

- Drag = look · Scroll = FOV · Preset buttons
- Tune yaw/pitch/FOV → **Target preset** → **Save current angles → preset**
  (writes `presets.json` — CLI export reads the same file)
- **Mark In / Mark Out + Add** → timeline → **Copy CLI cmd**

Prefer a short proxy MP4, not the multi-GB full stitch.

## Presets (shared)

Source of truth: **`presets.json`**. Preview + `node src/cli.mjs` share it.

Names: `forward` · `selfie` · `up` · `left` · `right` · `back`  
Calibrate per mount in the player. `selfie` is pre-seeded with one measured view (yaw 70 / pitch 46); overwrite the rest yourself.

```bash
node src/cli.mjs --list-presets
```

## Export (CLI)

```bash
node src/cli.mjs -i stitch.mp4 -o flat.mp4 -p forward
node src/cli.mjs -i stitch.mp4 -o flat.mp4 \
  -t "0:00-3:00=forward,3:00-3:25=selfie,3:25-end=forward"
```

Requires `ffmpeg` / `ffprobe` (`h264_nvenc` when available).

## Pipeline

1. MediaSDK: `.insv` → equirect MP4  
2. Preview: calibrate presets + mark timeline  
3. This CLI: equirect → flat  

## Not in scope (yet)

- Auto body-relative offset / face-assist  
- Studio Deep Track
