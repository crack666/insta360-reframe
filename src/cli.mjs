#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPresets, resolveSegmentView } from './presets.mjs';
import { parseTimeline, resolveTimeline } from './timeline.mjs';
import {
  probeDuration,
  pickVideoEncoder,
  encodeSegment,
  concatSegments,
} from './ffmpeg.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  console.log(`
insta360-reframe — Equirect → flat with direction presets

Chest-mount jogging / obstacle course workflow:
  MediaSDK stitch (equirect) → this tool → flat deliverable

USAGE:
  node src/cli.mjs --input equirect.mp4 --output flat.mp4 [options]

OPTIONS:
  --input, -i       Equirect MP4 (MediaSDK stitch)
  --output, -o      Flat MP4 output
  --preset, -p      Single preset for whole clip (default: forward)
                    ${Object.keys(loadPresets()).join(' | ')}
  --timeline, -t    Segment list, e.g.
                    "0-90=forward,90-120=selfie,120-150=custom@70/20/90"
  --timeline-file   File with one segment per line
  --width           Flat width (default 1280)
  --height          Flat height (default 720)
  --yaw/--pitch/--fov   Override preset yaw / pitch / h_fov (single-preset mode)
  --work-dir        Temp segment dir (default: <output>.work)
  --list-presets    Print presets and exit
  -h, --help

EXAMPLES:
  node src/cli.mjs -i stitch.mp4 -o out.mp4 -p forward
  node src/cli.mjs -i stitch.mp4 -o out.mp4 -t "0:00-2:00=forward,2:00-2:20=selfie,2:20-end=forward"
`);
}

function parseArgs(argv) {
  const opts = {
    input: null,
    output: null,
    preset: 'forward',
    timeline: null,
    timelineFile: null,
    width: 1280,
    height: 720,
    yaw: null,
    pitch: null,
    fov: null,
    workDir: null,
    listPresets: false,
    help: false,
  };
  const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const next = () => a[++i];
    switch (x) {
      case '-h': case '--help': opts.help = true; break;
      case '--list-presets': opts.listPresets = true; break;
      case '-i': case '--input': opts.input = next(); break;
      case '-o': case '--output': opts.output = next(); break;
      case '-p': case '--preset': opts.preset = next(); break;
      case '-t': case '--timeline': opts.timeline = next(); break;
      case '--timeline-file': opts.timelineFile = next(); break;
      case '--width': opts.width = parseInt(next(), 10); break;
      case '--height': opts.height = parseInt(next(), 10); break;
      case '--yaw': opts.yaw = parseFloat(next()); break;
      case '--pitch': opts.pitch = parseFloat(next()); break;
      case '--fov': opts.fov = parseFloat(next()); break;
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
  if (!opts.input || !opts.output) {
    usage();
    process.exit(1);
  }
  if (!fs.existsSync(opts.input)) {
    throw new Error(`Input not found: ${opts.input}`);
  }

  const duration = await probeDuration(opts.input);
  let segments = null;
  let timelineSpec = opts.timeline;

  function loadSegmentsFromJson(doc) {
    if (Array.isArray(doc.segments) && doc.segments.length) {
      return resolveTimeline(doc.segments, duration);
    }
    if (doc.timeline) return resolveTimeline(parseTimeline(doc.timeline), duration);
    return null;
  }

  if (opts.timelineFile) {
    const raw = fs.readFileSync(opts.timelineFile, 'utf8');
    if (opts.timelineFile.endsWith('.json')) {
      segments = loadSegmentsFromJson(JSON.parse(raw));
    } else {
      timelineSpec = raw;
    }
  } else if (!timelineSpec) {
    const jsonSide = `${opts.input}.timeline.json`;
    const txtSide = `${opts.input}.timeline.txt`;
    if (fs.existsSync(jsonSide)) {
      segments = loadSegmentsFromJson(JSON.parse(fs.readFileSync(jsonSide, 'utf8')));
      console.log(`timeline: ${jsonSide}`);
    } else if (fs.existsSync(txtSide)) {
      timelineSpec = fs.readFileSync(txtSide, 'utf8');
      console.log(`timeline: ${txtSide}`);
    }
  }

  if (!segments) {
    if (timelineSpec) {
      segments = resolveTimeline(parseTimeline(timelineSpec), duration);
    } else {
      segments = [{ start: 0, end: duration, preset: opts.preset }];
    }
  }

  function viewForSegment(seg) {
    return resolveSegmentView(seg);
  }

  const encoder = await pickVideoEncoder();
  const workDir = opts.workDir || `${opts.output}.work`;
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });

  console.log(`input:    ${opts.input}`);
  console.log(`duration: ${duration.toFixed(1)}s`);
  console.log(`encoder:  ${encoder.video}`);
  console.log(`segments: ${segments.length}`);

  const partFiles = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    let view = viewForSegment(seg);
    if (segments.length === 1) {
      if (opts.yaw != null) view = { ...view, yaw: opts.yaw };
      if (opts.pitch != null) view = { ...view, pitch: opts.pitch };
      if (opts.fov != null) view = { ...view, h_fov: opts.fov };
    }
    const tag = seg.preset === 'custom' ? 'custom' : seg.preset;
    const lensTag = seg.lens && seg.lens !== 'default' ? `+${seg.lens}` : '';
    const part = path.join(workDir, `seg_${String(i).padStart(3, '0')}_${tag}${lensTag.replace('+', '_')}.mp4`);
    console.log(
      `  [${i + 1}/${segments.length}] ${seg.start.toFixed(1)}–${seg.end.toFixed(1)}s  ${tag}${lensTag}` +
      `  (yaw=${view.yaw} pitch=${view.pitch} fov=${view.h_fov})`,
    );
    await encodeSegment({
      input: opts.input,
      output: part,
      start: seg.start,
      end: seg.end,
      view,
      width: opts.width,
      height: opts.height,
      encoder,
    });
    partFiles.push(part);
  }

  if (partFiles.length === 1) {
    fs.copyFileSync(partFiles[0], opts.output);
  } else {
    await concatSegments(partFiles, opts.output, workDir);
  }

  console.log(`done: ${opts.output}`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
