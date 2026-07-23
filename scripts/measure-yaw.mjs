/**
 * Optical yaw delta between equirect frames (equator strip cross-correlation).
 * Usage: node scripts/measure-yaw.mjs <ref.mp4> <other.mp4> [tSec]
 *        node scripts/measure-yaw.mjs --batch <dir> --ref 009 --times 1,30
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const W = 720;
const H = 360;
const ROW0 = 160;
const ROW1 = 200;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks = [];
    let err = '';
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`${cmd} exited ${code}\n${err.slice(-800)}`));
    });
  });
}

async function extractGray(videoPath, tSec, outPath) {
  await run('ffmpeg', [
    '-y', '-v', 'error',
    '-ss', String(tSec),
    '-i', videoPath,
    '-frames:v', '1',
    '-vf', `scale=${W}:${H},format=gray`,
    '-f', 'rawvideo',
    outPath,
  ]);
}

function loadStrip(grayPath) {
  const buf = fs.readFileSync(grayPath);
  if (buf.length < W * H) throw new Error(`short gray file: ${grayPath}`);
  const strip = new Float64Array(W);
  for (let x = 0; x < W; x++) {
    let s = 0;
    let n = 0;
    for (let y = ROW0; y < ROW1; y++) {
      s += buf[y * W + x];
      n++;
    }
    strip[x] = s / n;
  }
  let m = 0;
  for (const v of strip) m += v;
  m /= W;
  let v = 0;
  for (const v0 of strip) v += (v0 - m) * (v0 - m);
  v = Math.sqrt(v / W) || 1;
  for (let i = 0; i < W; i++) strip[i] = (strip[i] - m) / v;
  return strip;
}

function bestShift(a, b) {
  let best = 0;
  let bestScore = -1e99;
  for (let s = -Math.floor(W / 2); s <= Math.floor(W / 2); s++) {
    let score = 0;
    for (let i = 0; i < W; i++) {
      const j = (i + s + W * 10) % W;
      score += a[i] * b[j];
    }
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return {
    px: best,
    deg: best * (360 / W),
    corr: bestScore / W,
  };
}

export async function measureYawDelta(refVideo, otherVideo, tSec = 1, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const refGray = path.join(workDir, `ref_${tSec}.gray`);
  const othGray = path.join(workDir, `oth_${tSec}.gray`);
  await extractGray(refVideo, tSec, refGray);
  await extractGray(otherVideo, tSec, othGray);
  return bestShift(loadStrip(refGray), loadStrip(othGray));
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--batch') {
    const dir = args[1];
    const refIdx = args.indexOf('--ref');
    const timesIdx = args.indexOf('--times');
    const refId = refIdx >= 0 ? args[refIdx + 1] : '009';
    const times = (timesIdx >= 0 ? args[timesIdx + 1] : '1,30').split(',').map(Number);
    const work = path.join(dir, '_yaw');
    fs.mkdirSync(work, { recursive: true });
    const files = Object.fromEntries(
      fs.readdirSync(dir)
        .filter((f) => f.endsWith('.mp4'))
        .map((f) => [path.basename(f, '.mp4'), path.join(dir, f)]),
    );
    // also accept map of take ids pointing to paths via env BATCH_MAP json
    const mapPath = path.join(dir, 'sources.json');
    let sources = files;
    if (fs.existsSync(mapPath)) {
      sources = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    }
    if (!sources[refId]) throw new Error(`ref ${refId} missing in sources`);
    const rows = [];
    for (const t of times) {
      for (const [id, video] of Object.entries(sources)) {
        if (id === refId) {
          rows.push({ ref: refId, take: id, t, deg: 0, corr: 1, px: 0 });
          continue;
        }
        if (!fs.existsSync(video)) {
          rows.push({ ref: refId, take: id, t, deg: null, corr: null, error: 'missing' });
          continue;
        }
        const r = await measureYawDelta(sources[refId], video, t, path.join(work, `${id}_${t}`));
        rows.push({ ref: refId, take: id, t, deg: Number(r.deg.toFixed(2)), corr: Number(r.corr.toFixed(4)), px: r.px });
        console.log(`${id} vs ${refId} @${t}s → ${r.deg.toFixed(1)}° corr=${r.corr.toFixed(3)}`);
      }
    }
    const out = path.join(dir, 'yaw-baseline.json');
    fs.writeFileSync(out, `${JSON.stringify(rows, null, 2)}\n`);
    console.log('wrote', out);
    return;
  }

  const [ref, other, t = '1'] = args;
  if (!ref || !other) {
    console.error('Usage: node scripts/measure-yaw.mjs ref.mp4 other.mp4 [tSec]');
    process.exit(1);
  }
  const work = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'work', 'direction-experiments', '_yaw');
  // default work under data root if exists
  const dataWork = 'D:/ai/ai-stack/data/insta360/work/direction-experiments/_yaw';
  const r = await measureYawDelta(ref, other, Number(t), dataWork);
  console.log(JSON.stringify(r));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
