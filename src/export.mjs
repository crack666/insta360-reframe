/**
 * Shared flat export used by CLI and preview server.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveSegmentView } from './presets.mjs';
import { parseTimeline, resolveTimeline, serializeTimeline } from './timeline.mjs';
import {
  probeDuration,
  pickVideoEncoder,
  encodeSegment,
  concatSegments,
} from './ffmpeg.mjs';

/**
 * @param {object} opts
 * @param {string} opts.input
 * @param {string} opts.output
 * @param {object[]} [opts.segments]
 * @param {string} [opts.timeline]
 * @param {string} [opts.timelineFile]
 * @param {string} [opts.preset]
 * @param {number} [opts.width]
 * @param {number} [opts.height]
 * @param {'h264'|'hevc'} [opts.codec]
 * @param {'draft'|'medium'|'high'} [opts.quality]
 * @param {string} [opts.bitrate]  e.g. "8M" — if set, overrides CQ/CRF
 * @param {string} [opts.audioBitrate]
 * @param {string} [opts.workDir]
 * @param {(msg: object) => void} [opts.onProgress]
 */
export async function exportFlat(opts) {
  const input = path.resolve(opts.input);
  const output = path.resolve(opts.output);
  const width = opts.width || 1920;
  const height = opts.height || 1080;
  const preset = opts.preset || 'forward';
  const onProgress = opts.onProgress || (() => {});

  if (!fs.existsSync(input)) throw new Error(`Input not found: ${input}`);

  const duration = await probeDuration(input);
  let segments = null;

  function loadSegmentsFromJson(doc) {
    if (Array.isArray(doc.segments) && doc.segments.length) {
      return resolveTimeline(doc.segments, duration);
    }
    if (doc.timeline) return resolveTimeline(parseTimeline(doc.timeline), duration);
    return null;
  }

  if (Array.isArray(opts.segments) && opts.segments.length) {
    segments = resolveTimeline(opts.segments, duration);
  } else if (opts.timelineFile) {
    const raw = fs.readFileSync(opts.timelineFile, 'utf8');
    if (opts.timelineFile.endsWith('.json')) segments = loadSegmentsFromJson(JSON.parse(raw));
    else segments = resolveTimeline(parseTimeline(raw), duration);
  } else if (opts.timeline) {
    segments = resolveTimeline(parseTimeline(opts.timeline), duration);
  } else {
    const jsonSide = `${input}.timeline.json`;
    const txtSide = `${input}.timeline.txt`;
    if (fs.existsSync(jsonSide)) {
      segments = loadSegmentsFromJson(JSON.parse(fs.readFileSync(jsonSide, 'utf8')));
      onProgress({ type: 'info', message: `timeline: ${jsonSide}` });
    } else if (fs.existsSync(txtSide)) {
      segments = resolveTimeline(parseTimeline(fs.readFileSync(txtSide, 'utf8')), duration);
      onProgress({ type: 'info', message: `timeline: ${txtSide}` });
    }
  }

  if (!segments?.length) {
    segments = [{ start: 0, end: duration, preset }];
  }

  const encoder = await pickVideoEncoder({
    codec: opts.codec,
    quality: opts.quality,
    bitrate: opts.bitrate,
  });
  const audioBitrate = opts.audioBitrate || '160k';
  const workDir = opts.workDir || `${output}.work`;
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.dirname(output), { recursive: true });

  onProgress({
    type: 'start',
    duration,
    segments: segments.length,
    encoder: encoder.label || encoder.video,
    width,
    height,
    output,
    timeline: serializeTimeline(segments),
  });

  const partFiles = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const view = resolveSegmentView(seg);
    const tag = seg.preset === 'custom' ? 'custom' : seg.preset;
    const lensTag = seg.lens && seg.lens !== 'default' ? `_${seg.lens}` : '';
    const part = path.join(workDir, `seg_${String(i).padStart(3, '0')}_${tag}${lensTag}.mp4`);
    onProgress({
      type: 'segment',
      index: i,
      total: segments.length,
      start: seg.start,
      end: seg.end,
      preset: tag,
      lens: seg.lens || 'default',
      view: { yaw: view.yaw, pitch: view.pitch, h_fov: view.h_fov },
      progress: i / segments.length,
    });
    await encodeSegment({
      input,
      output: part,
      start: seg.start,
      end: seg.end,
      view,
      width,
      height,
      encoder,
      audioBitrate,
    });
    partFiles.push(part);
  }

  onProgress({ type: 'concat', progress: 0.95 });
  if (partFiles.length === 1) {
    fs.copyFileSync(partFiles[0], output);
  } else {
    await concatSegments(partFiles, output, workDir);
  }

  const size = fs.statSync(output).size;
  onProgress({ type: 'done', output, size, progress: 1 });
  return { output, size, duration, segments: segments.length, encoder: encoder.label || encoder.video };
}
