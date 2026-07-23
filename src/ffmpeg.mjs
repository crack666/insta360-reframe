import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { v360Filter } from './presets.mjs';

export function run(cmd, args, { cwd, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (onStderr) onStderr(s);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}\n${stderr.slice(-2000)}`));
    });
  });
}

export async function probeDuration(input) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    input,
  ]);
  const n = parseFloat(stdout.trim());
  if (Number.isNaN(n)) throw new Error(`Could not probe duration: ${input}`);
  return n;
}

let _encoderCache = null;

export async function listEncoders() {
  if (_encoderCache) return _encoderCache;
  let stdout = '';
  try {
    ({ stdout } = await run('ffmpeg', ['-hide_banner', '-encoders']));
  } catch {
    stdout = '';
  }
  _encoderCache = {
    h264_nvenc: /\bh264_nvenc\b/.test(stdout),
    hevc_nvenc: /\bhevc_nvenc\b/.test(stdout),
    libx264: /\blibx264\b/.test(stdout),
    libx265: /\blibx265\b/.test(stdout),
  };
  return _encoderCache;
}

/** AAC defaults for flat delivery (X5 source ~128–190k stereo AAC @ 48 kHz). */
export const AUDIO_BITRATE_BY_QUALITY = {
  draft: '96k',
  medium: '128k',
  high: '160k',
};

export function defaultAudioBitrate(quality = 'medium') {
  return AUDIO_BITRATE_BY_QUALITY[quality] || AUDIO_BITRATE_BY_QUALITY.medium;
}

/**
 * Suggested CBR target when overriding CQ/CRF — scaled for flat export res.
 * Tuned for Insta360 → flat social/master delivery (not equirect masters).
 */
export function suggestVideoBitrate(width = 1920, height = 1080, codec = 'h264', quality = 'medium') {
  const base1080 = codec === 'hevc'
    ? { draft: 3.5, medium: 7, high: 12 }
    : { draft: 5, medium: 10, high: 16 };
  const mbps = base1080[quality] ?? base1080.medium;
  const scale = Math.max(0.25, (Number(width) * Number(height)) / (1920 * 1080));
  const scaled = mbps * scale ** 0.75;
  const nice = scaled < 4
    ? Math.round(scaled * 2) / 2
    : Math.round(scaled);
  return `${nice}M`;
}

function parseBitrateToBufsize(br) {
  const m = String(br).trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM])?$/);
  if (!m) return String(br);
  const n = parseFloat(m[1]) * 2;
  const unit = m[2] || '';
  const whole = Number.isInteger(n) ? String(n) : String(n);
  return `${whole}${unit}`;
}

/**
 * @param {{ codec?: 'h264'|'hevc', quality?: 'draft'|'medium'|'high', bitrate?: string }} [opts]
 */
export async function pickVideoEncoder(opts = {}) {
  const codec = opts.codec === 'hevc' ? 'hevc' : 'h264';
  const quality = opts.quality || 'medium';
  const avail = await listEncoders();

  // Lower CQ/CRF = higher quality. NVENC CQ ≈ x264 CRF + ~3–4 visually.
  const cqMap = { draft: 28, medium: 23, high: 19 };
  const crfMap = { draft: 26, medium: 20, high: 17 };
  const cq = cqMap[quality] ?? 23;
  const crf = crfMap[quality] ?? 20;
  const pix = ['-pix_fmt', 'yuv420p'];

  if (opts.bitrate) {
    const br = String(opts.bitrate);
    const buf = parseBitrateToBufsize(br);
    if (codec === 'hevc' && avail.hevc_nvenc) {
      return {
        video: 'hevc_nvenc',
        extra: ['-preset', 'p4', '-rc', 'vbr', '-b:v', br, '-maxrate', br, '-bufsize', buf, ...pix],
        label: `hevc_nvenc ${br}`,
      };
    }
    if (codec === 'hevc' && avail.libx265) {
      return { video: 'libx265', extra: ['-preset', 'medium', '-b:v', br, ...pix], label: `libx265 ${br}` };
    }
    if (avail.h264_nvenc) {
      return {
        video: 'h264_nvenc',
        extra: ['-preset', 'p4', '-rc', 'vbr', '-b:v', br, '-maxrate', br, '-bufsize', buf, ...pix],
        label: `h264_nvenc ${br}`,
      };
    }
    return { video: 'libx264', extra: ['-preset', 'medium', '-b:v', br, ...pix], label: `libx264 ${br}` };
  }

  if (codec === 'hevc') {
    if (avail.hevc_nvenc) {
      return {
        video: 'hevc_nvenc',
        extra: ['-preset', 'p4', '-rc', 'vbr', '-cq', String(cq), '-b:v', '0', ...pix],
        label: `hevc_nvenc cq${cq}`,
      };
    }
    if (avail.libx265) {
      return { video: 'libx265', extra: ['-preset', 'medium', '-crf', String(crf), ...pix], label: `libx265 crf${crf}` };
    }
    // fall through to h264 if no hevc
  }

  if (avail.h264_nvenc) {
    return {
      video: 'h264_nvenc',
      extra: ['-preset', 'p4', '-rc', 'vbr', '-cq', String(cq), '-b:v', '0', ...pix],
      label: `h264_nvenc cq${cq}`,
    };
  }
  const x264Preset = quality === 'draft' ? 'veryfast' : 'medium';
  return {
    video: 'libx264',
    extra: ['-preset', x264Preset, '-crf', String(crf), ...pix],
    label: `libx264 crf${crf}`,
  };
}

/**
 * Encode one flat segment from equirect.
 */
export async function encodeSegment({
  input,
  output,
  start,
  end,
  view,
  width,
  height,
  encoder,
  audioBitrate = AUDIO_BITRATE_BY_QUALITY.medium,
  onStderr,
}) {
  const filter = v360Filter(view, { width, height });
  const args = [
    '-y',
    '-ss', String(start),
    '-to', String(end),
    '-i', input,
    '-vf', filter,
    '-c:v', encoder.video,
    ...encoder.extra,
    '-c:a', 'aac',
    '-b:a', audioBitrate,
    '-ar', '48000',
    '-ac', '2',
    '-movflags', '+faststart',
    output,
  ];
  await run('ffmpeg', args, { onStderr });
}

/** Concat demuxer join. */
export async function concatSegments(segmentFiles, output, workDir) {
  const listPath = path.join(workDir, 'concat.txt');
  const body = segmentFiles
    .map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(listPath, body, 'utf8');
  await run('ffmpeg', [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-c', 'copy',
    '-movflags', '+faststart',
    output,
  ]);
}
