/**
 * Final pipeline: master equirect (temp) → flat export → delete master.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  getInstaRoot,
  loadTake,
  saveTake,
  defaultTakePaths,
} from './project.mjs';
import { stitchTake } from './stitch.mjs';
import { exportFlat } from './export.mjs';

/**
 * @param {object} opts
 * @param {boolean} [opts.useProxyAsMaster] — smoke: skip MediaSDK final stitch
 * @param {boolean} [opts.keepMaster] — keep work/equirect_master.mp4
 */
export async function renderFinal(projectId, takeId, {
  root = getInstaRoot(),
  useProxyAsMaster = false,
  keepMaster = false,
  onProgress,
  onLog,
} = {}) {
  const { take, paths } = loadTake(projectId, takeId, root);
  const timelinePath = paths.timelineJson;
  if (!fs.existsSync(timelinePath) && !fs.existsSync(paths.timelineTxt)) {
    throw new Error(`No timeline for take ${projectId}/${takeId} — edit in preview first`);
  }

  take.status = 'rendering_final';
  take.error = null;
  saveTake(projectId, take, root);

  let masterPath;
  try {
    if (useProxyAsMaster) {
      if (!take.proxy?.path || !fs.existsSync(take.proxy.path)) {
        throw new Error('useProxyAsMaster requires a proxy equirect');
      }
      masterPath = take.proxy.path;
      onLog?.(`using proxy as master: ${masterPath}`);
    } else {
      const st = await stitchTake(projectId, takeId, {
        profile: 'final',
        root,
        onLog,
      });
      masterPath = st.outputHost;
    }

    fs.mkdirSync(paths.finalDir, { recursive: true });
    const output = take.final?.path || paths.finalMp4;
    const width = take.final?.width || 1920;
    const height = take.final?.height || 1080;

    const result = await exportFlat({
      input: masterPath,
      output,
      timelineFile: fs.existsSync(timelinePath) ? timelinePath : paths.timelineTxt,
      width,
      height,
      codec: take.final?.codec || 'h264',
      quality: take.final?.quality || 'high',
      viewOffset: take.viewOffset || null,
      presetOverrides: take.presetOverrides || null,
      workDir: path.join(paths.workDir, 'flat.work'),
      onProgress,
    });

    take.final = {
      ...take.final,
      path: result.output,
      width,
      height,
      size: result.size,
      encoder: result.encoder,
    };
    take.status = 'done';
    saveTake(projectId, take, root);

    if (!useProxyAsMaster && !keepMaster && fs.existsSync(paths.masterMp4)) {
      fs.unlinkSync(paths.masterMp4);
      onLog?.(`deleted temp master: ${paths.masterMp4}`);
    }

    return { take, output: result.output, size: result.size };
  } catch (err) {
    const { take: t } = loadTake(projectId, takeId, root);
    t.status = 'error';
    t.error = String(err.message || err);
    saveTake(projectId, t, root);
    throw err;
  }
}

export function importTimeline(projectId, takeId, fromPath, { root = getInstaRoot() } = {}) {
  const paths = defaultTakePaths(projectId, takeId, root);
  fs.mkdirSync(paths.timelineDir, { recursive: true });
  const src = path.resolve(fromPath);
  if (!fs.existsSync(src)) throw new Error(`Timeline source not found: ${src}`);

  if (src.endsWith('.json')) {
    fs.copyFileSync(src, paths.timelineJson);
    const doc = JSON.parse(fs.readFileSync(src, 'utf8'));
    if (doc.timeline) {
      fs.writeFileSync(paths.timelineTxt, `${String(doc.timeline).replace(/,/g, '\n')}\n`, 'utf8');
    }
  } else {
    fs.copyFileSync(src, paths.timelineTxt);
  }

  const { take } = loadTake(projectId, takeId, root);
  take.timeline = { path: paths.timelineJson };
  take.status = take.proxy ? 'editing' : take.status;
  saveTake(projectId, take, root);
  return take;
}
