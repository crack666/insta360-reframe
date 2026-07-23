/**
 * Project / take paths and manifests.
 * Root: INSTA360_ROOT or D:/ai/ai-stack/data/insta360
 */
import fs from 'node:fs';
import path from 'node:path';

export const TAKE_STATUSES = [
  'draft',
  'stitching_proxy',
  'proxy_ready',
  'editing',
  'rendering_final',
  'done',
  'error',
];

const DEFAULT_ROOT = 'D:/ai/ai-stack/data/insta360';

export function getInstaRoot() {
  return path.resolve(process.env.INSTA360_ROOT || DEFAULT_ROOT);
}

export function projectsDir(root = getInstaRoot()) {
  return path.join(root, 'projects');
}

export function inboxDir(root = getInstaRoot()) {
  return path.join(root, 'inbox');
}

/** Map host path under INSTA360_ROOT → /data/... for MediaSDK container. */
export function toContainerPath(hostPath, root = getInstaRoot()) {
  const abs = path.resolve(hostPath);
  const base = path.resolve(root);
  const rel = path.relative(base, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path outside INSTA360_ROOT: ${abs}`);
  }
  return `/data/${rel.replace(/\\/g, '/')}`;
}

export function takeDir(projectId, takeId, root = getInstaRoot()) {
  return path.join(projectsDir(root), projectId, 'takes', takeId);
}

export function defaultTakePaths(projectId, takeId, root = getInstaRoot()) {
  const base = takeDir(projectId, takeId, root);
  return {
    takeDir: base,
    takeJson: path.join(base, 'take.json'),
    proxyDir: path.join(base, 'proxy'),
    proxyMp4: path.join(base, 'proxy', 'equirect.mp4'),
    timelineDir: path.join(base, 'timeline'),
    timelineJson: path.join(base, 'timeline', 'timeline.json'),
    timelineTxt: path.join(base, 'timeline', 'timeline.txt'),
    finalDir: path.join(base, 'final'),
    finalMp4: path.join(base, 'final', 'flat.mp4'),
    workDir: path.join(base, 'work'),
    masterMp4: path.join(base, 'work', 'equirect_master.mp4'),
  };
}

export function emptyProject(id, label = id) {
  return {
    version: 1,
    id,
    label,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    takes: [],
    /** After all take flats: write projects/<id>/out/session.mp4 */
    concatFinals: true,
    export: defaultExportSettings(),
    /** Copied onto new takes as starting viewOffset (optional). */
    defaultViewOffset: { yaw: 0, pitch: 0, roll: 0 },
  };
}

export function defaultExportSettings() {
  return {
    width: 1920,
    height: 1080,
    codec: 'h264',
    quality: 'medium',
    bitrate: null,
    audioBitrate: null,
  };
}

export function normalizeExportSettings(raw = {}) {
  const d = defaultExportSettings();
  const width = Math.max(160, Number(raw.width) || d.width);
  const height = Math.max(90, Number(raw.height) || d.height);
  const codec = String(raw.codec || d.codec).toLowerCase() === 'hevc' ? 'hevc' : 'h264';
  const q = String(raw.quality || d.quality).toLowerCase();
  const quality = (q === 'draft' || q === 'high') ? q : 'medium';
  const bitrate = raw.bitrate != null && String(raw.bitrate).trim()
    ? String(raw.bitrate).trim()
    : null;
  const audioBitrate = raw.audioBitrate != null && String(raw.audioBitrate).trim()
    ? String(raw.audioBitrate).trim()
    : null;
  return { width, height, codec, quality, bitrate, audioBitrate };
}

export function projectPaths(projectId, root = getInstaRoot()) {
  const projectDir = path.join(projectsDir(root), projectId);
  return {
    projectDir,
    projectJson: path.join(projectDir, 'project.json'),
    outDir: path.join(projectDir, 'out'),
    sessionMp4: path.join(projectDir, 'out', 'session.mp4'),
  };
}

export function getProjectExportSettings(project) {
  return normalizeExportSettings(project?.export || {});
}

export function setProjectExportSettings(projectId, partial = {}, {
  root = getInstaRoot(),
  concatFinals,
} = {}) {
  const { project } = loadProject(projectId, root);
  project.export = normalizeExportSettings({ ...getProjectExportSettings(project), ...partial });
  if (concatFinals != null) project.concatFinals = !!concatFinals;
  saveProject(project, root);
  return project;
}

export function emptyTake(id, { raw = [], label, viewOffset } = {}) {
  return {
    version: 1,
    id: String(id),
    label: label || `Take ${id}`,
    raw: raw.map((p) => path.resolve(p)),
    status: 'draft',
    error: null,
    proxy: null,
    timeline: null,
    /** Per-take yaw/pitch/roll added to named presets (not custom segments). */
    viewOffset: {
      yaw: Number(viewOffset?.yaw) || 0,
      pitch: Number(viewOffset?.pitch) || 0,
      roll: Number(viewOffset?.roll) || 0,
    },
    /** Per-take absolute named-preset angles (do not touch global presets.json). */
    presetOverrides: {},
    final: {
      path: null,
      width: 1920,
      height: 1080,
      codec: 'h264',
      quality: 'high',
    },
    stitch: {
      flowstate: true,
      directionLock: true,
      proxyOutputSize: '1920x960',
      finalOutputSize: '3840x1920',
    },
    updated: new Date().toISOString(),
  };
}

export function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function saveJson(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out = { ...doc, updated: new Date().toISOString() };
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  return out;
}

export function loadProject(projectId, root = getInstaRoot()) {
  const file = path.join(projectsDir(root), projectId, 'project.json');
  if (!fs.existsSync(file)) throw new Error(`Project not found: ${projectId}`);
  return { file, project: loadJson(file) };
}

export function saveProject(project, root = getInstaRoot()) {
  const file = path.join(projectsDir(root), project.id, 'project.json');
  return saveJson(file, project);
}

export function loadTake(projectId, takeId, root = getInstaRoot()) {
  const paths = defaultTakePaths(projectId, takeId, root);
  if (!fs.existsSync(paths.takeJson)) throw new Error(`Take not found: ${projectId}/${takeId}`);
  return { paths, take: loadJson(paths.takeJson) };
}

export function saveTake(projectId, take, root = getInstaRoot()) {
  const paths = defaultTakePaths(projectId, take.id, root);
  return { paths, take: saveJson(paths.takeJson, take) };
}

/** Parse take id from Insta filename: VID_…_00_011.insv → 011 */
export function takeIdFromInsv(filePath) {
  const base = path.basename(filePath);
  const m = base.match(/_(\d{3})\.(insv|insp)$/i) || base.match(/_(\d+)\.(insv|insp)$/i);
  if (!m) throw new Error(`Cannot parse take id from: ${base}`);
  return m[1];
}

/**
 * Group inbox .insv into takes: pair *_00_* with matching *_10_* when present.
 * @returns {{ id: string, files: string[] }[]}
 */
export function groupInboxTakes(files) {
  const insv = files.filter((f) => /\.insv$/i.test(f));
  const byId = new Map();
  for (const f of insv) {
    const id = takeIdFromInsv(f);
    const base = path.basename(f);
    const role = /_10_/.test(base) ? '10' : /_00_/.test(base) ? '00' : 'other';
    if (!byId.has(id)) byId.set(id, { id, '00': null, '10': null, other: [] });
    const g = byId.get(id);
    if (role === '00' || role === '10') g[role] = path.resolve(f);
    else g.other.push(path.resolve(f));
  }
  const out = [];
  for (const g of byId.values()) {
    const filesOrdered = [];
    if (g['00']) filesOrdered.push(g['00']);
    if (g['10']) filesOrdered.push(g['10']);
    filesOrdered.push(...g.other);
    if (filesOrdered.length) out.push({ id: g.id, files: filesOrdered });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function ensureTakeDirs(projectId, takeId, root = getInstaRoot()) {
  const p = defaultTakePaths(projectId, takeId, root);
  for (const d of [p.takeDir, p.proxyDir, p.timelineDir, p.finalDir, p.workDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return p;
}

export function createProject(id, { label, root = getInstaRoot() } = {}) {
  const dir = path.join(projectsDir(root), id);
  fs.mkdirSync(path.join(dir, 'takes'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  const project = emptyProject(id, label || id);
  saveProject(project, root);
  return project;
}

export function listProjects(root = getInstaRoot()) {
  const dir = projectsDir(root);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name, 'project.json');
    if (!fs.existsSync(file)) continue;
    try {
      const project = loadJson(file);
      out.push({
        id: project.id || name,
        label: project.label || name,
        takes: project.takes || [],
        updated: project.updated || null,
      });
    } catch {
      /* skip broken */
    }
  }
  return out.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
}

export function listInboxInsv(root = getInstaRoot()) {
  const dir = inboxDir(root);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter((f) => /\.insv$/i.test(f))
    .map((f) => path.join(dir, f));
  return groupInboxTakes(files).map((g) => ({
    id: g.id,
    files: g.files,
    names: g.files.map((f) => path.basename(f)),
  }));
}

export function addTake(projectId, takeId, rawFiles, { label, root = getInstaRoot(), viewOffset } = {}) {
  const { project } = loadProject(projectId, root);
  ensureTakeDirs(projectId, takeId, root);
  const offset = viewOffset || project.defaultViewOffset || { yaw: 0, pitch: 0, roll: 0 };
  const take = emptyTake(takeId, { raw: rawFiles, label, viewOffset: offset });
  const paths = defaultTakePaths(projectId, takeId, root);
  take.final.path = paths.finalMp4;
  saveTake(projectId, take, root);
  if (!project.takes.includes(takeId)) {
    project.takes.push(takeId);
    saveProject(project, root);
  }
  return take;
}

export function setTakeViewOffset(projectId, takeId, offset, { root = getInstaRoot() } = {}) {
  const { take } = loadTake(projectId, takeId, root);
  take.viewOffset = {
    yaw: Number(offset.yaw) || 0,
    pitch: Number(offset.pitch) || 0,
    roll: Number(offset.roll) || 0,
  };
  saveTake(projectId, take, root);
  return take;
}

export function copyTakeViewOffset(projectId, fromTakeId, toTakeId, { root = getInstaRoot() } = {}) {
  const { take: from } = loadTake(projectId, fromTakeId, root);
  return setTakeViewOffset(projectId, toTakeId, from.viewOffset || {}, { root });
}

export function setTakePresetOverride(projectId, takeId, presetName, angles, { root = getInstaRoot() } = {}) {
  const key = String(presetName || '').toLowerCase();
  if (!key || key === 'custom') throw new Error('Ungültiger Preset-Name');
  const { take } = loadTake(projectId, takeId, root);
  if (!take.presetOverrides || typeof take.presetOverrides !== 'object') take.presetOverrides = {};
  take.presetOverrides[key] = {
    yaw: Number(angles.yaw) || 0,
    pitch: Number(angles.pitch) || 0,
    roll: Number(angles.roll) || 0,
    h_fov: Number(angles.h_fov ?? angles.fov) || 120,
    v_fov: Number(angles.v_fov) || 70,
    label: angles.label || key,
  };
  saveTake(projectId, take, root);
  return take;
}

export function clearTakePresetOverride(projectId, takeId, presetName, { root = getInstaRoot() } = {}) {
  const key = String(presetName || '').toLowerCase();
  const { take } = loadTake(projectId, takeId, root);
  if (take.presetOverrides && key in take.presetOverrides) {
    delete take.presetOverrides[key];
    saveTake(projectId, take, root);
  }
  return take;
}

const MIN_PROXY_BYTES = 500_000;

/**
 * Force-clear a stuck stitch/final state (treat any job as dead).
 * Recovers proxy from disk when present, otherwise back to draft.
 */
export function resetTakeJobState(projectId, takeId, { root = getInstaRoot() } = {}) {
  return reconcileTakeJobState(projectId, takeId, { root, getJob: () => null, force: true });
}

/**
 * Remove take from project list. Optionally delete the take folder on disk.
 */
export function removeTake(projectId, takeId, { root = getInstaRoot(), deleteFiles = false } = {}) {
  const { project } = loadProject(projectId, root);
  const id = String(takeId);
  project.takes = (project.takes || []).filter((t) => t !== id);
  saveProject(project, root);
  if (deleteFiles) {
    const paths = defaultTakePaths(projectId, id, root);
    if (fs.existsSync(paths.takeDir)) {
      fs.rmSync(paths.takeDir, { recursive: true, force: true });
    }
  }
  return project;
}

/**
 * After server restart, in-memory jobs are gone but take.status may stay
 * `stitching_proxy` / `rendering_final`. Recover from disk if possible.
 * @param {(id: string) => object|null} [getJob] live job lookup; missing = treat as dead
 * @param {boolean} [force] ignore live job and reset anyway
 * @returns {{ take: object, changed: boolean, paths: object }}
 */
export function reconcileTakeJobState(projectId, takeId, { root = getInstaRoot(), getJob = () => null, force = false } = {}) {
  const { take, paths } = loadTake(projectId, takeId, root);
  const busy = take.status === 'stitching_proxy' || take.status === 'rendering_final';
  if (!busy && !take.activeJobId) {
    return { take, paths, changed: false };
  }

  const job = take.activeJobId ? getJob(take.activeJobId) : null;
  const live = !force && job && (job.status === 'queued' || job.status === 'running');
  if (live) return { take, paths, changed: false };

  let changed = false;
  if (take.activeJobId) {
    take.activeJobId = null;
    changed = true;
  }

  // Drop partials from killed MediaSDK runs
  const partial = `${paths.proxyMp4}.partial`;
  if (fs.existsSync(partial)) {
    try { fs.unlinkSync(partial); } catch { /* ignore */ }
  }

  if (take.status === 'stitching_proxy') {
    const proxyPath = take.proxy?.path || paths.proxyMp4;
    let size = 0;
    try { size = fs.existsSync(proxyPath) ? fs.statSync(proxyPath).size : 0; } catch { size = 0; }
    if (size >= MIN_PROXY_BYTES) {
      const [w, h] = String(take.stitch?.proxyOutputSize || '1920x960').split('x').map(Number);
      take.proxy = {
        path: proxyPath,
        width: w || take.proxy?.width || null,
        height: h || take.proxy?.height || null,
        outputSize: take.stitch?.proxyOutputSize || take.proxy?.outputSize || null,
        backend: take.stitch?.lastBackend || take.proxy?.backend || null,
        recoveredAfterRestart: true,
      };
      take.status = 'proxy_ready';
      take.error = null;
      changed = true;
    } else {
      take.status = 'draft';
      take.error = 'Proxy-Job unterbrochen (Server-Neustart) — erneut „Proxy erzeugen“.';
      changed = true;
    }
  } else if (take.status === 'rendering_final') {
    take.status = take.proxy?.path && fs.existsSync(take.proxy.path) ? 'editing' : 'proxy_ready';
    take.error = 'Final-Job unterbrochen (Server-Neustart).';
    changed = true;
  }

  if (changed) saveTake(projectId, take, root);
  return { take, paths, changed };
}

/** Heuristic final equirect size from flat width (Phase-0 decision). */
export function suggestFinalOutputSize(flatWidth = 1920) {
  const w = Math.max(3840, Math.round(Number(flatWidth) * 2));
  const h = Math.round(w / 2);
  return `${w}x${h}`;
}
