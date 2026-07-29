/**
 * E1: DirectionLock A/B stitch into work/direction-experiments (does not overwrite project proxies).
 *
 *   node scripts/run-direction-ab.mjs
 *
 * Uses takes 009+010+011. Full-length stitch — 011 is short (~40s); 009/010 are long
 * (progress logged; can Ctrl+C after 011 pair if needed). Prefer starting with 011 only:
 *
 *   node scripts/run-direction-ab.mjs --takes 011
 */
import fs from 'node:fs';
import path from 'node:path';
import { stitchTake } from '../src/stitch.mjs';
import { measureYawDelta } from './measure-yaw.mjs';

const WORK = 'D:/ai/ai-stack/data/insta360/work/direction-experiments';
const PROJECT = 'smoke-011';

function parseTakes(argv) {
  const i = argv.indexOf('--takes');
  if (i < 0) return ['011', '009', '010']; // short first
  return argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
}

async function stitchVariant(takeId, { directionLock, tag }) {
  const out = path.join(WORK, `stitch_${takeId}_${tag}.mp4`);
  console.log(`\n=== Stitch ${takeId} ${tag} → ${out} ===`);
  const t0 = Date.now();
  await stitchTake(PROJECT, takeId, {
    profile: 'proxy',
    outputHost: out,
    outputSize: '1920x960',
    flowstate: true,
    directionLock,
    updateManifest: false,
    onLog: (line) => {
      const s = String(line);
      if (/process\s*=|progress|error|Error|%/.test(s)) console.log(' ', s.slice(0, 160));
    },
  });
  const sec = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`done ${takeId} ${tag} in ${sec}s size=${(fs.statSync(out).size / 1e6).toFixed(1)}MB`);
  return out;
}

async function main() {
  fs.mkdirSync(WORK, { recursive: true });
  const takes = parseTakes(process.argv.slice(2));
  const paths = {};
  const proxyOf = (id) => `D:/ai/ai-stack/data/insta360/projects/smoke-011/takes/${id}/proxy/equirect.mp4`;

  for (const takeId of takes) {
    // Lock ON (A): reuse existing project proxy when present (already stitched with directionlock)
    const existing = proxyOf(takeId);
    if (fs.existsSync(existing)) {
      const dest = path.join(WORK, `stitch_${takeId}_lock_on.mp4`);
      // Prefer symlink/junction copy for speed — hardlink if same volume
      try {
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        fs.linkSync(existing, dest);
      } catch {
        fs.copyFileSync(existing, dest);
      }
      paths[`${takeId}_lock_on`] = dest;
      console.log(`reuse proxy as lock_on: ${takeId}`);
    } else {
      paths[`${takeId}_lock_on`] = await stitchVariant(takeId, {
        directionLock: true,
        tag: 'lock_on',
      });
    }
    // Lock OFF (B): always re-stitch
    paths[`${takeId}_lock_off`] = await stitchVariant(takeId, {
      directionLock: false,
      tag: 'lock_off',
    });
  }

  // Measure cross-take yaw for lock_on and lock_off groups
  const ref = takes[0];
  const rows = [];
  for (const mode of ['lock_on', 'lock_off']) {
    const refPath = paths[`${ref}_${mode}`];
    for (const takeId of takes) {
      if (takeId === ref) {
        rows.push({ mode, ref, take: takeId, t: 1, deg: 0, corr: 1 });
        continue;
      }
      const other = paths[`${takeId}_${mode}`];
      if (!refPath || !other || !fs.existsSync(refPath) || !fs.existsSync(other)) continue;
      const r = await measureYawDelta(refPath, other, 1, path.join(WORK, `_yaw_${mode}_${takeId}`));
      rows.push({
        mode,
        ref,
        take: takeId,
        t: 1,
        deg: Number(r.deg.toFixed(2)),
        corr: Number(r.corr.toFixed(4)),
      });
      console.log(`[${mode}] ${takeId} vs ${ref} → ${r.deg.toFixed(1)}° corr=${r.corr.toFixed(3)}`);
    }
  }

  const outJson = path.join(WORK, 'e1-directionlock-ab.json');
  fs.writeFileSync(outJson, `${JSON.stringify({ takes, paths, rows }, null, 2)}\n`);
  console.log('wrote', outJson);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
