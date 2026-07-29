/**
 * Optical auto-offset: estimate Δyaw between take proxies via equator cross-correlation,
 * optionally write take.viewOffset for named presets.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  getInstaRoot,
  loadProject,
  loadTake,
  setTakeViewOffset,
  defaultTakePaths,
} from './project.mjs';
import { measureYawDelta } from '../scripts/measure-yaw.mjs';

export async function alignTakesOptical(
  projectId,
  {
    refId = '009',
    tSec = 1,
    apply = false,
    root = getInstaRoot(),
  } = {},
) {
  const { project } = loadProject(projectId, root);
  const refPaths = defaultTakePaths(projectId, refId, root);
  const refProxy = loadTake(projectId, refId, root).take.proxy?.path || refPaths.proxyMp4;
  if (!fs.existsSync(refProxy)) throw new Error(`Ref proxy missing: ${refProxy}`);

  const workDir = path.join(root, 'work', 'direction-experiments', '_align');
  fs.mkdirSync(workDir, { recursive: true });

  const results = [];
  for (const takeId of project.takes || []) {
    if (takeId === refId) {
      if (apply) setTakeViewOffset(projectId, takeId, { yaw: 0, pitch: 0, roll: 0 }, { root });
      results.push({ takeId, deg: 0, corr: 1, yawOffset: 0, applied: !!apply });
      continue;
    }
    const { take, paths } = loadTake(projectId, takeId, root);
    const proxy = take.proxy?.path || paths.proxyMp4;
    if (!proxy || !fs.existsSync(proxy)) {
      results.push({ takeId, error: 'no proxy' });
      continue;
    }
    try {
      const r = await measureYawDelta(refProxy, proxy, tSec, path.join(workDir, takeId));
      const yaw = Math.round(r.deg);
      const row = {
        takeId,
        deg: Number(r.deg.toFixed(2)),
        corr: Number(r.corr.toFixed(4)),
        yawOffset: yaw,
      };
      if (apply) {
        setTakeViewOffset(projectId, takeId, { yaw, pitch: 0, roll: 0 }, { root });
        row.applied = true;
      }
      results.push(row);
    } catch (err) {
      results.push({ takeId, error: String(err.message || err) });
    }
  }

  const out = {
    projectId,
    refId,
    tSec,
    apply: !!apply,
    results,
  };
  const outPath = path.join(workDir, `align-${projectId}-ref${refId}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  out.outPath = outPath;
  return out;
}
