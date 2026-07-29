/**
 * Estimate optical yaw offset between take proxies and optionally apply viewOffset.
 *
 *   node scripts/align-takes-optical.mjs smoke-011 --ref 009 --apply
 *   node scripts/align-takes-optical.mjs smoke-011 --ref 009 --dry-run
 */
import { alignTakesOptical } from '../src/align-optical.mjs';

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return fallback;
  return process.argv[i + 1] ?? true;
}

async function main() {
  const projectId = process.argv[2];
  if (!projectId || projectId.startsWith('-')) {
    console.error('Usage: node scripts/align-takes-optical.mjs <project> --ref 009 [--apply] [--t 1]');
    process.exit(1);
  }
  const refId = String(arg('--ref', '009'));
  const tSec = Number(arg('--t', '1')) || 1;
  const apply = process.argv.includes('--apply');

  const out = await alignTakesOptical(projectId, { refId, tSec, apply });
  for (const r of out.results) {
    if (r.error) {
      console.log(`${r.takeId}: ${r.error}`);
      continue;
    }
    console.log(
      `${r.takeId} vs ${refId}: Δyaw=${r.deg}° corr=${r.corr}` +
        (r.yawOffset != null ? ` → viewOffset.yaw=${r.yawOffset}` : '') +
        (r.applied ? ' (applied)' : ''),
    );
  }
  console.log('wrote', out.outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
