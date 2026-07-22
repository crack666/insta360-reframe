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
    concatFinals: false,
  };
}

export function emptyTake(id, { raw = [], label } = {}) {
  return {
    version: 1,
    id: String(id),
    label: label || `Take ${id}`,
    raw: raw.map((p) => path.resolve(p)),
    status: 'draft',
    error: null,
    proxy: null,
    timeline: null,
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

export function addTake(projectId, takeId, rawFiles, { label, root = getInstaRoot() } = {}) {
  const { project } = loadProject(projectId, root);
  ensureTakeDirs(projectId, takeId, root);
  const take = emptyTake(takeId, { raw: rawFiles, label });
  const paths = defaultTakePaths(projectId, takeId, root);
  take.final.path = paths.finalMp4;
  saveTake(projectId, take, root);
  if (!project.takes.includes(takeId)) {
    project.takes.push(takeId);
    saveProject(project, root);
  }
  return take;
}

/** Heuristic final equirect size from flat width (Phase-0 decision). */
export function suggestFinalOutputSize(flatWidth = 1920) {
  const w = Math.max(3840, Math.round(Number(flatWidth) * 2));
  const h = Math.round(w / 2);
  return `${w}x${h}`;
}
