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

/**
 * @param {{ codec?: 'h264'|'hevc', quality?: 'draft'|'medium'|'high', bitrate?: string, audioBitrate?: string }} [opts]
 */
export async function pickVideoEncoder(opts = {}) {
  const codec = opts.codec === 'hevc' ? 'hevc' : 'h264';
  const quality = opts.quality || 'medium';
  const avail = await listEncoders();

  // Lower CQ/CRF = higher quality
  const cqMap = { draft: 28, medium: 23, high: 19 };
  const crfMap = { draft: 26, medium: 20, high: 17 };
  const cq = cqMap[quality] ?? 23;
  const crf = crfMap[quality] ?? 20;

  if (opts.bitrate) {
    const br = String(opts.bitrate);
    if (codec === 'hevc' && avail.hevc_nvenc) {
      return { video: 'hevc_nvenc', extra: ['-preset', 'p4', '-b:v', br, '-maxrate', br, '-bufsize', br], label: `hevc_nvenc ${br}` };
    }
    if (codec === 'hevc' && avail.libx265) {
      return { video: 'libx265', extra: ['-preset', 'medium', '-b:v', br], label: `libx265 ${br}` };
    }
    if (avail.h264_nvenc) {
      return { video: 'h264_nvenc', extra: ['-preset', 'p4', '-b:v', br, '-maxrate', br, '-bufsize', br], label: `h264_nvenc ${br}` };
    }
    return { video: 'libx264', extra: ['-preset', 'medium', '-b:v', br], label: `libx264 ${br}` };
  }

  if (codec === 'hevc') {
    if (avail.hevc_nvenc) {
      return { video: 'hevc_nvenc', extra: ['-preset', 'p4', '-cq', String(cq)], label: `hevc_nvenc cq${cq}` };
    }
    if (avail.libx265) {
      return { video: 'libx265', extra: ['-preset', 'medium', '-crf', String(crf)], label: `libx265 crf${crf}` };
    }
    // fall through to h264 if no hevc
  }

  if (avail.h264_nvenc) {
    return { video: 'h264_nvenc', extra: ['-preset', 'p4', '-cq', String(cq)], label: `h264_nvenc cq${cq}` };
  }
  return { video: 'libx264', extra: ['-preset', 'veryfast', '-crf', String(crf)], label: `libx264 crf${crf}` };
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
  audioBitrate = '160k',
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
