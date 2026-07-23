#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPresets } from './presets.mjs';
import { exportFlat } from './export.mjs';
import { listEncoders } from './ffmpeg.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  console.log(`
insta360-reframe — Equirect → flat with direction presets

USAGE:
  node src/cli.mjs --input equirect.mp4 --output flat.mp4 [options]

OPTIONS:
  --input, -i       Equirect MP4 (MediaSDK stitch)
  --output, -o      Flat MP4 output
  --preset, -p      Single preset for whole clip (default: forward)
                    ${Object.keys(loadPresets()).join(' | ')}
  --timeline, -t    Segment list
  --timeline-file   File (.txt or .timeline.json)
  --width           Flat width (default 1920)
  --height          Flat height (default 1080)
  --codec           h264 | hevc  (default h264; hevc = H.265 when available)
  --quality         draft | medium | high  (CQ/CRF mode, default medium)
  --bitrate         e.g. 8M / 12M — if set, overrides quality CQ/CRF
  --audio-bitrate   AAC; default by quality: draft 96k / medium 128k / high 160k
  --yaw/--pitch/--fov   Override (single-preset mode only via timeline empty)
  --work-dir        Temp segment dir (default: <output>.work)
  --list-presets    Print presets and exit
  --list-encoders   Print available encoders and exit
  -h, --help

EXAMPLES:
  node src/cli.mjs -i stitch.mp4 -o out.mp4
  node src/cli.mjs -i stitch.mp4 -o out.mp4 --width 1920 --height 1080 --codec hevc --quality high
`);
}

function parseArgs(argv) {
  const opts = {
    input: null,
    output: null,
    preset: 'forward',
    timeline: null,
    timelineFile: null,
    width: 1920,
    height: 1080,
    codec: 'h264',
    quality: 'medium',
    bitrate: null,
    audioBitrate: null,
    workDir: null,
    listPresets: false,
    listEncoders: false,
    help: false,
  };
  const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const next = () => a[++i];
    switch (x) {
      case '-h': case '--help': opts.help = true; break;
      case '--list-presets': opts.listPresets = true; break;
      case '--list-encoders': opts.listEncoders = true; break;
      case '-i': case '--input': opts.input = next(); break;
      case '-o': case '--output': opts.output = next(); break;
      case '-p': case '--preset': opts.preset = next(); break;
      case '-t': case '--timeline': opts.timeline = next(); break;
      case '--timeline-file': opts.timelineFile = next(); break;
      case '--width': opts.width = parseInt(next(), 10); break;
      case '--height': opts.height = parseInt(next(), 10); break;
      case '--codec': opts.codec = next(); break;
      case '--quality': opts.quality = next(); break;
      case '--bitrate': opts.bitrate = next(); break;
      case '--audio-bitrate': opts.audioBitrate = next(); break;
      case '--work-dir': opts.workDir = next(); break;
      default:
        if (x.startsWith('-')) throw new Error(`Unknown option: ${x}`);
        if (!opts.input) opts.input = x;
        else if (!opts.output) opts.output = x;
        break;
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { usage(); return; }
  if (opts.listPresets) {
    for (const [k, v] of Object.entries(loadPresets())) {
      console.log(`${k.padEnd(8)} yaw=${v.yaw} pitch=${v.pitch} h_fov=${v.h_fov}  — ${v.label}`);
    }
    return;
  }
  if (opts.listEncoders) {
    console.log(await listEncoders());
    return;
  }
  if (!opts.input || !opts.output) {
    usage();
    process.exit(1);
  }

  const result = await exportFlat({
    ...opts,
    onProgress: (ev) => {
      if (ev.type === 'start') {
        console.log(`input:    ${opts.input}`);
        console.log(`duration: ${ev.duration.toFixed(1)}s`);
        console.log(`encoder:  ${ev.encoder}`);
        console.log(`size:     ${ev.width}x${ev.height}`);
        console.log(`segments: ${ev.segments}`);
      } else if (ev.type === 'segment') {
        console.log(
          `  [${ev.index + 1}/${ev.total}] ${ev.start.toFixed(1)}–${ev.end.toFixed(1)}s  ${ev.preset}` +
          (ev.lens !== 'default' ? `+${ev.lens}` : '') +
          `  (yaw=${ev.view.yaw} pitch=${ev.view.pitch} fov=${ev.view.h_fov})`,
        );
      } else if (ev.type === 'done') {
        console.log(`done: ${ev.output} (${(ev.size / 1e6).toFixed(1)} MB)`);
      }
    },
  });
  return result;
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
