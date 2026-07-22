import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { v360Filter } from './presets.mjs';

export function run(cmd, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
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

/** Prefer NVENC when available. */
export async function pickVideoEncoder() {
  try {
    const { stdout } = await run('ffmpeg', ['-hide_banner', '-encoders']);
    if (/\bh264_nvenc\b/.test(stdout)) return { video: 'h264_nvenc', extra: ['-preset', 'p4', '-cq', '23'] };
  } catch {
    /* fall through */
  }
  return { video: 'libx264', extra: ['-preset', 'veryfast', '-crf', '20'] };
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
    '-b:a', '128k',
    '-movflags', '+faststart',
    output,
  ];
  await run('ffmpeg', args);
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
