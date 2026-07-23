/**
 * Final pipeline: master equirect (temp) → flat export → delete master.
 * Project batch: proxy → flat per take → optional session concat.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  getInstaRoot,
  loadTake,
  saveTake,
  loadProject,
  saveProject,
  defaultTakePaths,
  projectPaths,
  getProjectExportSettings,
} from './project.mjs';
import { stitchTake } from './stitch.mjs';
import { exportFlat } from './export.mjs';
import { concatSegments, defaultAudioBitrate } from './ffmpeg.mjs';

/**
 * @param {object} opts
 * @param {boolean} [opts.useProxyAsMaster] — smoke: skip MediaSDK final stitch
 * @param {boolean} [opts.keepMaster] — keep work/equirect_master.mp4
 * @param {object} [opts.settings] — override width/height/codec/quality/bitrate
 */
export async function renderFinal(projectId, takeId, {
  root = getInstaRoot(),
  useProxyAsMaster = false,
  keepMaster = false,
  settings = null,
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
    const width = settings?.width || take.final?.width || 1920;
    const height = settings?.height || take.final?.height || 1080;
    const codec = settings?.codec || take.final?.codec || 'h264';
    const quality = settings?.quality || take.final?.quality || 'high';
    const bitrate = settings?.bitrate || null;
    const audioBitrate = settings?.audioBitrate || defaultAudioBitrate(quality);

    const result = await exportFlat({
      input: masterPath,
      output,
      timelineFile: fs.existsSync(timelinePath) ? timelinePath : paths.timelineTxt,
      width,
      height,
      codec,
      quality,
      bitrate,
      audioBitrate,
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
      codec,
      quality,
      size: result.size,
      encoder: result.encoder,
      fromProxy: !!useProxyAsMaster,
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

/**
 * Export all takes (proxy → flat with each take's timeline) then concat to out/session.mp4.
 * @param {object} [opts]
 * @param {boolean} [opts.concatOnly] — skip re-render; concat existing flats in take order
 */
export async function renderProjectFinals(projectId, {
  root = getInstaRoot(),
  concatOnly = false,
  onProgress,
  onLog,
} = {}) {
  const { project } = loadProject(projectId, root);
  const settings = getProjectExportSettings(project);
  const pp = projectPaths(projectId, root);
  const takeIds = [...(project.takes || [])];
  const exported = [];
  const skipped = [];
  const flatFiles = [];

  const report = (ev) => {
    onProgress?.(ev);
    if (ev.message) onLog?.(ev.message);
  };

  if (!takeIds.length) throw new Error('Projekt hat keine Takes');

  if (!concatOnly) {
    for (let i = 0; i < takeIds.length; i++) {
      const takeId = takeIds[i];
      const base = (i / takeIds.length) * 0.88;
      const span = 0.88 / takeIds.length;
      try {
        const { take, paths } = loadTake(projectId, takeId, root);
        const proxyPath = take.proxy?.path || paths.proxyMp4;
        if (!proxyPath || !fs.existsSync(proxyPath)) {
          skipped.push({ takeId, reason: 'kein Proxy' });
          report({
            type: 'skip',
            takeId,
            index: i,
            total: takeIds.length,
            progress: base + span,
            message: `Take ${takeId}: übersprungen (kein Proxy)`,
          });
          continue;
        }
        const hasTl = fs.existsSync(paths.timelineJson) || fs.existsSync(paths.timelineTxt);
        if (!hasTl) {
          skipped.push({ takeId, reason: 'keine Timeline' });
          report({
            type: 'skip',
            takeId,
            index: i,
            total: takeIds.length,
            progress: base + span,
            message: `Take ${takeId}: übersprungen (keine Timeline)`,
          });
          continue;
        }

        report({
          type: 'take',
          takeId,
          index: i,
          total: takeIds.length,
          progress: base,
          message: `Take ${takeId} (${i + 1}/${takeIds.length}): Flat rendern…`,
        });

        const r = await renderFinal(projectId, takeId, {
          root,
          useProxyAsMaster: true,
          settings,
          onLog,
          onProgress: (ev) => {
            if (ev.type === 'segment') {
              const local = (ev.index + 0.5) / Math.max(ev.total, 1);
              report({
                type: 'segment',
                takeId,
                index: i,
                total: takeIds.length,
                progress: base + local * span * 0.95,
                message: `Take ${takeId}: Segment ${ev.index + 1}/${ev.total}`,
              });
            } else if (ev.type === 'start') {
              report({
                type: 'take',
                takeId,
                index: i,
                total: takeIds.length,
                progress: base + 0.02,
                message: `Take ${takeId}: ${ev.width}×${ev.height} · ${ev.encoder}`,
              });
            }
          },
        });
        exported.push({ takeId, output: r.output, size: r.size });
        flatFiles.push(r.output);
        report({
          type: 'take-done',
          takeId,
          index: i,
          total: takeIds.length,
          progress: base + span,
          message: `Take ${takeId}: Flat fertig`,
        });
      } catch (err) {
        skipped.push({ takeId, reason: String(err.message || err) });
        report({
          type: 'skip',
          takeId,
          index: i,
          total: takeIds.length,
          progress: base + span,
          message: `Take ${takeId}: Fehler — ${err.message || err}`,
        });
      }
    }
  } else {
    for (const takeId of takeIds) {
      const { take, paths } = loadTake(projectId, takeId, root);
      const flat = take.final?.path || paths.finalMp4;
      if (flat && fs.existsSync(flat)) flatFiles.push(flat);
      else skipped.push({ takeId, reason: 'kein Flat' });
    }
  }

  let session = null;
  const doConcat = project.concatFinals !== false;
  if (doConcat && flatFiles.length >= 1) {
    fs.mkdirSync(pp.outDir, { recursive: true });
    const out = pp.sessionMp4;
    report({
      type: 'concat',
      progress: 0.92,
      message: flatFiles.length === 1
        ? 'Ein Flat → Session-Datei kopieren…'
        : `Zusammenfügen (${flatFiles.length} Takes)…`,
    });
    if (flatFiles.length === 1) {
      fs.copyFileSync(flatFiles[0], out);
    } else {
      const workDir = path.join(pp.outDir, 'concat.work');
      fs.mkdirSync(workDir, { recursive: true });
      await concatSegments(flatFiles, out, workDir);
    }
    const size = fs.statSync(out).size;
    session = { path: out, size, takes: flatFiles.length };
    project.session = {
      path: out,
      size,
      takeCount: flatFiles.length,
      export: settings,
      updated: new Date().toISOString(),
    };
    saveProject(project, root);
    report({ type: 'done', progress: 1, message: `Session: ${out}`, session });
  } else if (!flatFiles.length) {
    throw new Error(
      skipped.length
        ? `Kein Flat erzeugt. Übersprungen: ${skipped.map((s) => `${s.takeId} (${s.reason})`).join(', ')}`
        : 'Keine Flats zum Zusammenfügen',
    );
  } else {
    report({
      type: 'done',
      progress: 1,
      message: `${exported.length} Flats fertig (Concat aus)`,
    });
  }

  return {
    projectId,
    settings,
    exported,
    skipped,
    session,
    concatFinals: doConcat,
  };
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
