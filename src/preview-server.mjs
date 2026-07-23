#!/usr/bin/env node
/**
 * App server: Wizard (projects/takes) + equirect preview editor.
 *
 *   node src/preview-server.mjs                    → wizard at /
 *   node src/preview-server.mjs --video equirect.mp4
 *   node src/preview-server.mjs --project smoke-011 --take 011
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadPresetsDoc, savePresetsDoc, updatePreset, PRESETS_PATH } from './presets.mjs';
import { analyzeSuggestions } from './suggest.mjs';
import { parseTimeline, serializeTimeline } from './timeline.mjs';
import { exportFlat } from './export.mjs';
import {
  listEncoders,
  defaultAudioBitrate,
  suggestVideoBitrate,
  AUDIO_BITRATE_BY_QUALITY,
} from './ffmpeg.mjs';
import {
  getInstaRoot,
  listProjects,
  listInboxInsv,
  createProject,
  addTake,
  loadProject,
  loadTake,
  saveTake,
  saveProject,
  defaultTakePaths,
  setTakeViewOffset,
  copyTakeViewOffset,
  setTakePresetOverride,
  clearTakePresetOverride,
  reconcileTakeJobState,
  resetTakeJobState,
  removeTake,
} from './project.mjs';
import { stitchTake, setProxyFile } from './stitch.mjs';
import {
  createJob,
  getJob,
  listJobs,
  startJob,
  appendJobLog,
  updateJob,
  publicJob,
  parseProgressLine,
} from './jobs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PREVIEW = path.join(ROOT, 'preview');

/** @type {{ videoPath: string|null, projectId: string|null, takeId: string|null }} */
const session = {
  videoPath: null,
  projectId: null,
  takeId: null,
};

function timelinePathFor(video) {
  return `${video}.timeline.json`;
}

function takeTimelinePaths() {
  if (!session.projectId || !session.takeId) return null;
  return defaultTakePaths(session.projectId, session.takeId);
}

function activateVideo(videoPath, { projectId = null, takeId = null } = {}) {
  const abs = path.resolve(videoPath);
  if (!fs.existsSync(abs)) throw new Error(`Video not found: ${abs}`);
  session.videoPath = abs;
  session.projectId = projectId;
  session.takeId = takeId;
  return session;
}

function activateTake(projectId, takeId) {
  const { take, paths } = loadTake(projectId, takeId);
  if (!take.proxy?.path || !fs.existsSync(take.proxy.path)) {
    throw new Error('Kein Proxy vorhanden — zuerst Proxy erzeugen');
  }
  return activateVideo(take.proxy.path, { projectId, takeId });
}

function requireVideo() {
  if (!session.videoPath || !fs.existsSync(session.videoPath)) {
    throw new Error('Kein Video aktiv — im Wizard Take öffnen oder --video setzen');
  }
  return session.videoPath;
}

/** In-memory export job status for the UI. */
let exportJob = {
  running: false,
  progress: 0,
  message: '',
  log: [],
  output: null,
  error: null,
  startedAt: null,
  finishedAt: null,
};

function parseArgs(argv) {
  const opts = { video: null, project: null, take: null, port: 8787, open: true };
  const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--video' || a[i] === '-v') opts.video = a[++i];
    else if (a[i] === '--project') opts.project = a[++i];
    else if (a[i] === '--take') opts.take = a[++i];
    else if (a[i] === '--port' || a[i] === '-p') opts.port = parseInt(a[++i], 10);
    else if (a[i] === '--no-open') opts.open = false;
    else if (!a[i].startsWith('-') && !opts.video) opts.video = a[i];
  }
  return opts;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.mp4': 'video/mp4',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendFile(res, filePath, req) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404).end('Not found');
    return;
  }
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';

  const range = req.headers.range;
  if (range && ext === '.mp4') {
    const m = range.match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : Math.min(start + 1024 * 1024 - 1, stat.size - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': type,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  }

  res.writeHead(200, {
    'Content-Length': stat.size,
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
  });
  fs.createReadStream(filePath).pipe(res);
}

function openBrowser(url) {
  const plat = process.platform;
  if (plat === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
  else if (plat === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' });
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
}

function persistTimeline(videoPath, body) {
  let segments = Array.isArray(body.segments) ? body.segments : [];
  if (!segments.length && body.timeline) segments = parseTimeline(body.timeline);
  const timelineStr = body.timeline || serializeTimeline(segments);
  const companion = timelinePathFor(videoPath);
  const out = {
    version: 1,
    video: videoPath,
    timeline: timelineStr,
    segments,
    updated: new Date().toISOString(),
  };
  fs.writeFileSync(companion, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  fs.writeFileSync(`${videoPath}.timeline.txt`, `${timelineStr.replace(/,/g, '\n')}\n`, 'utf8');

  const tp = takeTimelinePaths();
  if (tp) {
    fs.mkdirSync(tp.timelineDir, { recursive: true });
    fs.writeFileSync(tp.timelineJson, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
    fs.writeFileSync(tp.timelineTxt, `${timelineStr.replace(/,/g, '\n')}\n`, 'utf8');
    try {
      const { take } = loadTake(session.projectId, session.takeId);
      take.timeline = { path: tp.timelineJson };
      if (take.status === 'proxy_ready') take.status = 'editing';
      saveTake(session.projectId, take);
    } catch {
      /* ignore */
    }
  }
  return { ...out, path: tp?.timelineJson || companion, companion };
}

const opts = parseArgs(process.argv);
if (opts.project && opts.take) {
  try {
    activateTake(opts.project, opts.take);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
} else if (opts.video) {
  try {
    activateVideo(opts.video);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const method = req.method || 'GET';

  try {
    // —— Static ——
    if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/home') {
      sendFile(res, path.join(PREVIEW, 'home.html'), req);
      return;
    }
    if (url.pathname === '/edit' || url.pathname === '/editor') {
      sendFile(res, path.join(PREVIEW, 'edit.html'), req);
      return;
    }
    if (url.pathname.startsWith('/preview/')) {
      sendFile(res, path.join(PREVIEW, url.pathname.slice('/preview/'.length)), req);
      return;
    }
    if (url.pathname === '/media') {
      try {
        sendFile(res, requireVideo(), req);
      } catch (err) {
        res.writeHead(404).end(String(err.message));
      }
      return;
    }

    // —— Presets ——
    if (url.pathname === '/api/presets' && method === 'GET') {
      json(res, 200, { ...loadPresetsDoc(), path: PRESETS_PATH });
      return;
    }
    if (url.pathname === '/api/presets' && method === 'PUT') {
      const body = JSON.parse(await readBody(req));
      const saved = savePresetsDoc(body);
      json(res, 200, { ok: true, ...saved, path: PRESETS_PATH });
      return;
    }
    if (url.pathname.startsWith('/api/presets/') && method === 'PUT') {
      const name = decodeURIComponent(url.pathname.slice('/api/presets/'.length));
      const body = JSON.parse(await readBody(req));
      const saved = updatePreset(name, body);
      json(res, 200, { ok: true, name, preset: saved.presets[name], path: PRESETS_PATH });
      return;
    }

    // —— Session / info ——
    if (url.pathname === '/api/info') {
      const video = session.videoPath;
      let viewOffset = { yaw: 0, pitch: 0, roll: 0 };
      let presetOverrides = {};
      let siblingTakes = [];
      if (session.projectId && session.takeId) {
        try {
          const { project } = loadProject(session.projectId);
          const { take } = loadTake(session.projectId, session.takeId);
          viewOffset = take.viewOffset || viewOffset;
          presetOverrides = take.presetOverrides || {};
          siblingTakes = (project.takes || []).filter((t) => t !== session.takeId);
        } catch {
          /* ignore */
        }
      }
      json(res, 200, {
        ok: true,
        mode: video ? 'editor' : 'wizard',
        video: video,
        name: video ? path.basename(video) : null,
        size: video && fs.existsSync(video) ? fs.statSync(video).size : null,
        presetsPath: PRESETS_PATH,
        timelinePath: video ? (takeTimelinePaths()?.timelineJson || timelinePathFor(video)) : null,
        projectId: session.projectId,
        takeId: session.takeId,
        viewOffset,
        presetOverrides,
        siblingTakes,
        instaRoot: getInstaRoot(),
      });
      return;
    }

    // —— Projects / inbox ——
    if (url.pathname === '/api/projects' && method === 'GET') {
      json(res, 200, { ok: true, projects: listProjects(), root: getInstaRoot() });
      return;
    }

    if (url.pathname === '/api/projects' && method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const id = String(body.id || '').trim().replace(/[^\w\-]+/g, '-');
      if (!id) {
        json(res, 400, { ok: false, error: 'Projekt-ID fehlt' });
        return;
      }
      if (listProjects().some((p) => p.id === id)) {
        json(res, 409, { ok: false, error: 'Projekt existiert bereits' });
        return;
      }
      const project = createProject(id, { label: body.label || id });
      json(res, 201, { ok: true, project });
      return;
    }

    if (url.pathname === '/api/inbox' && method === 'GET') {
      json(res, 200, { ok: true, takes: listInboxInsv() });
      return;
    }

    const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (projectMatch && method === 'GET') {
      const projectId = decodeURIComponent(projectMatch[1]);
      const { project } = loadProject(projectId);
      const takes = [];
      for (const tid of project.takes || []) {
        try {
          const { take, paths } = reconcileTakeJobState(projectId, tid, { getJob });
          const activeJob = take.activeJobId
            ? publicJob(getJob(take.activeJobId))
            : publicJob(listJobs({ projectId, takeId: tid, activeOnly: true, limit: 1 })[0]);
          takes.push({
            ...take,
            hasProxy: !!(take.proxy?.path && fs.existsSync(take.proxy.path)),
            hasTimeline: fs.existsSync(paths.timelineJson),
            hasFinal: !!(take.final?.path && fs.existsSync(take.final.path)),
            activeJob: activeJob || null,
            paths: {
              proxy: paths.proxyMp4,
              timeline: paths.timelineJson,
              final: paths.finalMp4,
            },
          });
        } catch {
          takes.push({ id: tid, status: 'error', error: 'take.json fehlt' });
        }
      }
      json(res, 200, { ok: true, project, takes });
      return;
    }

    const reorderMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/reorder$/);
    if (reorderMatch && method === 'POST') {
      const projectId = decodeURIComponent(reorderMatch[1]);
      const body = JSON.parse(await readBody(req) || '{}');
      const { project } = loadProject(projectId);
      if (!Array.isArray(body.takes)) {
        json(res, 400, { ok: false, error: 'takes[] erwartet' });
        return;
      }
      const set = new Set(project.takes);
      const next = body.takes.map(String).filter((t) => set.has(t));
      for (const t of project.takes) if (!next.includes(t)) next.push(t);
      project.takes = next;
      saveProject(project);
      json(res, 200, { ok: true, project });
      return;
    }

    const addTakeMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/takes$/);
    if (addTakeMatch && method === 'POST') {
      const projectId = decodeURIComponent(addTakeMatch[1]);
      const body = JSON.parse(await readBody(req) || '{}');
      const inbox = listInboxInsv();
      let files = body.files;
      let takeId = body.takeId || body.id;
      if (body.fromInbox && body.takeId) {
        const g = inbox.find((t) => t.id === String(body.takeId));
        if (!g) {
          json(res, 404, { ok: false, error: `Inbox-Take ${body.takeId} nicht gefunden` });
          return;
        }
        files = g.files;
        takeId = g.id;
      }
      if (!takeId || !files?.length) {
        json(res, 400, { ok: false, error: 'takeId + files oder fromInbox nötig' });
        return;
      }
      const take = addTake(projectId, String(takeId), files, { label: body.label });
      json(res, 201, { ok: true, take });
      return;
    }

    const offsetMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/takes\/([^/]+)\/offset$/);
    if (offsetMatch && method === 'GET') {
      const projectId = decodeURIComponent(offsetMatch[1]);
      const takeId = decodeURIComponent(offsetMatch[2]);
      const { take } = loadTake(projectId, takeId);
      json(res, 200, { ok: true, viewOffset: take.viewOffset || { yaw: 0, pitch: 0, roll: 0 } });
      return;
    }
    if (offsetMatch && method === 'PUT') {
      const projectId = decodeURIComponent(offsetMatch[1]);
      const takeId = decodeURIComponent(offsetMatch[2]);
      const body = JSON.parse(await readBody(req) || '{}');
      const take = setTakeViewOffset(projectId, takeId, body.viewOffset || body);
      // Keep project default in sync optionally
      if (body.setAsProjectDefault) {
        const { project } = loadProject(projectId);
        project.defaultViewOffset = { ...take.viewOffset };
        saveProject(project);
      }
      json(res, 200, { ok: true, take, viewOffset: take.viewOffset });
      return;
    }

    const copyOffsetMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/takes\/([^/]+)\/copy-offset$/);
    if (copyOffsetMatch && method === 'POST') {
      const projectId = decodeURIComponent(copyOffsetMatch[1]);
      const takeId = decodeURIComponent(copyOffsetMatch[2]);
      const body = JSON.parse(await readBody(req) || '{}');
      if (!body.fromTake) {
        json(res, 400, { ok: false, error: 'fromTake fehlt' });
        return;
      }
      const take = copyTakeViewOffset(projectId, String(body.fromTake), takeId);
      json(res, 200, { ok: true, take, viewOffset: take.viewOffset });
      return;
    }

    const takePresetMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/takes\/([^/]+)\/presets\/([^/]+)$/);
    if (takePresetMatch && (method === 'PUT' || method === 'DELETE')) {
      const projectId = decodeURIComponent(takePresetMatch[1]);
      const takeId = decodeURIComponent(takePresetMatch[2]);
      const presetName = decodeURIComponent(takePresetMatch[3]);
      try {
        if (method === 'DELETE') {
          const take = clearTakePresetOverride(projectId, takeId, presetName);
          json(res, 200, { ok: true, take, presetOverrides: take.presetOverrides || {} });
          return;
        }
        const body = JSON.parse(await readBody(req) || '{}');
        const take = setTakePresetOverride(projectId, takeId, presetName, body);
        json(res, 200, {
          ok: true,
          take,
          name: String(presetName).toLowerCase(),
          preset: take.presetOverrides[String(presetName).toLowerCase()],
          presetOverrides: take.presetOverrides || {},
        });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err.message || err) });
      }
      return;
    }

    const openTakeMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/takes\/([^/]+)\/open$/);
    if (openTakeMatch && method === 'POST') {
      const projectId = decodeURIComponent(openTakeMatch[1]);
      const takeId = decodeURIComponent(openTakeMatch[2]);
      activateTake(projectId, takeId);
      // Prefer take timeline if present
      const tp = takeTimelinePaths();
      if (tp && fs.existsSync(tp.timelineJson) && session.videoPath) {
        const companion = timelinePathFor(session.videoPath);
        if (!fs.existsSync(companion)) {
          fs.copyFileSync(tp.timelineJson, companion);
        }
      }
      json(res, 200, {
        ok: true,
        editUrl: `/edit?project=${encodeURIComponent(projectId)}&take=${encodeURIComponent(takeId)}`,
        video: session.videoPath,
        projectId,
        takeId,
      });
      return;
    }

    const resetJobMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/takes\/([^/]+)\/reset-job$/);
    if (resetJobMatch && method === 'POST') {
      const projectId = decodeURIComponent(resetJobMatch[1]);
      const takeId = decodeURIComponent(resetJobMatch[2]);
      try {
        const { take, changed } = resetTakeJobState(projectId, takeId);
        json(res, 200, { ok: true, take, changed });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err.message || err) });
      }
      return;
    }

    const takeDeleteMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/takes\/([^/]+)$/);
    if (takeDeleteMatch && method === 'DELETE') {
      const projectId = decodeURIComponent(takeDeleteMatch[1]);
      const takeId = decodeURIComponent(takeDeleteMatch[2]);
      let body = {};
      try {
        const raw = await readBody(req);
        if (raw.trim()) body = JSON.parse(raw);
      } catch {
        body = {};
      }
      try {
        const project = removeTake(projectId, takeId, { deleteFiles: !!body.deleteFiles });
        json(res, 200, { ok: true, project, removed: takeId });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err.message || err) });
      }
      return;
    }

    const stitchMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/takes\/([^/]+)\/stitch-proxy$/);
    if (stitchMatch && method === 'POST') {
      const projectId = decodeURIComponent(stitchMatch[1]);
      const takeId = decodeURIComponent(stitchMatch[2]);
      // Clear stale stitching_* after server restart (in-memory jobs are gone)
      reconcileTakeJobState(projectId, takeId, { getJob });
      // One active stitch per take
      const existing = listJobs({ projectId, takeId, activeOnly: true, limit: 1 })[0];
      if (existing) {
        json(res, 202, { ok: true, job: publicJob(existing), resumed: true });
        return;
      }
      const job = createJob('stitch-proxy', { projectId, takeId });
      try {
        const { take } = loadTake(projectId, takeId);
        take.activeJobId = job.id;
        take.status = 'stitching_proxy';
        take.error = null;
        saveTake(projectId, take);
      } catch {
        /* ignore */
      }
      startJob(job.id, async (j) => {
        updateJob(j.id, { message: 'MediaSDK Stitch (Proxy)…' });
        try {
          const r = await stitchTake(projectId, takeId, {
            profile: 'proxy',
            onLog: (line) => {
              appendJobLog(j.id, line);
              const t = String(line).trim();
              const pct = parseProgressLine(t);
              const patch = {};
              if (pct != null) patch.progress = pct;
              if (t.length > 2 && t.length < 200) patch.message = t;
              if (Object.keys(patch).length) updateJob(j.id, patch);
            },
          });
          updateJob(j.id, { message: `Proxy fertig: ${r.outputHost}`, progress: 1 });
          try {
            const { take } = loadTake(projectId, takeId);
            take.activeJobId = null;
            saveTake(projectId, take);
          } catch {
            /* ignore */
          }
          return { output: r.outputHost, outputSize: r.outputSize, backend: r.backend };
        } catch (err) {
          try {
            const { take } = loadTake(projectId, takeId);
            take.activeJobId = null;
            saveTake(projectId, take);
          } catch {
            /* ignore */
          }
          throw err;
        }
      });
      json(res, 202, { ok: true, job: publicJob(job) });
      return;
    }

    const setProxyMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/takes\/([^/]+)\/set-proxy$/);
    if (setProxyMatch && method === 'POST') {
      const projectId = decodeURIComponent(setProxyMatch[1]);
      const takeId = decodeURIComponent(setProxyMatch[2]);
      const body = JSON.parse(await readBody(req) || '{}');
      if (!body.file) {
        json(res, 400, { ok: false, error: 'file fehlt' });
        return;
      }
      const take = setProxyFile(projectId, takeId, body.file);
      json(res, 200, { ok: true, take });
      return;
    }

    if (url.pathname === '/api/jobs' && method === 'GET') {
      const projectId = url.searchParams.get('project');
      const takeId = url.searchParams.get('take');
      const activeOnly = url.searchParams.get('active') !== '0';
      const list = listJobs({
        projectId: projectId || null,
        takeId: takeId || null,
        activeOnly,
        limit: 20,
      }).map(publicJob);
      json(res, 200, { ok: true, jobs: list });
      return;
    }

    if (url.pathname.startsWith('/api/jobs/') && method === 'GET') {
      const id = url.pathname.slice('/api/jobs/'.length);
      const job = getJob(id);
      if (!job) {
        json(res, 404, { ok: false, error: 'Job nicht gefunden' });
        return;
      }
      json(res, 200, { ok: true, job: publicJob(job) });
      return;
    }

    // —— Timeline / suggest / export (need active video) ——
    if (url.pathname === '/api/timeline' && method === 'GET') {
      const videoPath = requireVideo();
      const tp = takeTimelinePaths();
      const p = (tp && fs.existsSync(tp.timelineJson)) ? tp.timelineJson : timelinePathFor(videoPath);
      if (!fs.existsSync(p)) {
        json(res, 200, { ok: true, segments: [], path: p });
        return;
      }
      const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
      json(res, 200, { ok: true, ...doc, path: p });
      return;
    }

    if (url.pathname === '/api/timeline' && method === 'PUT') {
      const videoPath = requireVideo();
      const body = JSON.parse(await readBody(req));
      const out = persistTimeline(videoPath, body);
      json(res, 200, { ok: true, ...out });
      return;
    }

    if (url.pathname === '/api/suggest' && method === 'POST') {
      const videoPath = requireVideo();
      let body = {};
      try {
        const raw = await readBody(req);
        if (raw.trim()) body = JSON.parse(raw);
      } catch {
        body = {};
      }
      const result = await analyzeSuggestions(videoPath, {
        defaultPreset: body.defaultPreset || 'forward',
        pausePreset: body.pausePreset || 'selfie',
        fps: body.fps || 2,
        enableCalm: body.enableCalm,
        enableValleys: body.enableValleys,
        enableSkin: body.enableSkin,
        enableSpikes: body.enableSpikes,
        calmStrictness: body.calmStrictness,
        minCalmSec: body.minCalmSec,
        minSkinPct: body.minSkinPct,
        skinStepSec: body.skinStepSec,
        minConfidence: body.minConfidence,
        proposedMinConfidence: body.proposedMinConfidence,
      });
      const suggestPath = `${videoPath}.suggestions.json`;
      fs.writeFileSync(suggestPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      json(res, 200, { ok: true, path: suggestPath, ...result });
      return;
    }

    if (url.pathname === '/api/export/options' && method === 'GET') {
      const videoPath = requireVideo();
      const encoders = await listEncoders();
      const tp = takeTimelinePaths();
      const defaultOut = tp?.finalMp4
        || path.join(path.dirname(videoPath), `${path.basename(videoPath, path.extname(videoPath))}_flat.mp4`);
      json(res, 200, {
        ok: true,
        encoders,
        codecs: [
          { id: 'h264', label: 'H.264', available: encoders.h264_nvenc || encoders.libx264 },
          { id: 'hevc', label: 'H.265 / HEVC', available: encoders.hevc_nvenc || encoders.libx265 },
        ],
        resolutions: [
          { id: '720p', width: 1280, height: 720, label: '1280×720' },
          { id: '1080p', width: 1920, height: 1080, label: '1920×1080' },
          { id: '1440p', width: 2560, height: 1440, label: '2560×1440' },
        ],
        qualities: [
          { id: 'draft', label: 'Draft (schnell)', audioBitrate: AUDIO_BITRATE_BY_QUALITY.draft },
          { id: 'medium', label: 'Medium', audioBitrate: AUDIO_BITRATE_BY_QUALITY.medium },
          { id: 'high', label: 'High', audioBitrate: AUDIO_BITRATE_BY_QUALITY.high },
        ],
        audioBitrateByQuality: AUDIO_BITRATE_BY_QUALITY,
        suggestedBitrates: {
          h264: {
            '720p': suggestVideoBitrate(1280, 720, 'h264', 'medium'),
            '1080p': suggestVideoBitrate(1920, 1080, 'h264', 'medium'),
            '1440p': suggestVideoBitrate(2560, 1440, 'h264', 'medium'),
          },
          hevc: {
            '720p': suggestVideoBitrate(1280, 720, 'hevc', 'medium'),
            '1080p': suggestVideoBitrate(1920, 1080, 'hevc', 'medium'),
            '1440p': suggestVideoBitrate(2560, 1440, 'hevc', 'medium'),
          },
        },
        defaultOutput: defaultOut,
      });
      return;
    }

    if (url.pathname === '/api/export/status' && method === 'GET') {
      json(res, 200, { ok: true, ...exportJob, log: exportJob.log.slice(-40) });
      return;
    }

    if (url.pathname === '/api/export' && method === 'POST') {
      const videoPath = requireVideo();
      if (exportJob.running) {
        json(res, 409, { ok: false, error: 'Export läuft bereits', ...exportJob });
        return;
      }
      let body = {};
      try {
        const raw = await readBody(req);
        if (raw.trim()) body = JSON.parse(raw);
      } catch {
        body = {};
      }

      if (Array.isArray(body.segments) && body.segments.length) {
        persistTimeline(videoPath, body);
      }

      const tp = takeTimelinePaths();
      const output = path.resolve(
        body.output || tp?.finalMp4
        || path.join(path.dirname(videoPath), `${path.basename(videoPath, path.extname(videoPath))}_flat.mp4`),
      );
      const width = Number(body.width) || 1920;
      const height = Number(body.height) || 1080;

      exportJob = {
        running: true,
        progress: 0,
        message: 'Starte Export…',
        log: [],
        output,
        error: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      };

      json(res, 202, { ok: true, started: true, output });

      setImmediate(async () => {
        try {
          let viewOffset = body.viewOffset || null;
          let presetOverrides = body.presetOverrides || null;
          if (session.projectId && session.takeId) {
            try {
              const { take } = loadTake(session.projectId, session.takeId);
              if (!viewOffset) viewOffset = take.viewOffset || null;
              if (!presetOverrides) presetOverrides = take.presetOverrides || null;
            } catch {
              /* ignore */
            }
          }
          await exportFlat({
            input: videoPath,
            output,
            segments: body.segments,
            width,
            height,
            codec: body.codec || 'h264',
            quality: body.quality || 'medium',
            bitrate: body.bitrate || null,
            audioBitrate: body.audioBitrate || defaultAudioBitrate(body.quality || 'medium'),
            viewOffset,
            presetOverrides,
            onProgress: (ev) => {
              if (ev.type === 'start') {
                exportJob.message = `${ev.width}×${ev.height} · ${ev.encoder} · ${ev.segments} Segmente`;
                exportJob.log.push(exportJob.message);
                exportJob.progress = 0.02;
              } else if (ev.type === 'segment') {
                exportJob.progress = (ev.index + 0.5) / Math.max(ev.total, 1);
                exportJob.message = `Segment ${ev.index + 1}/${ev.total}: ${ev.preset}`
                  + (ev.lens !== 'default' ? `+${ev.lens}` : '');
                exportJob.log.push(exportJob.message);
              } else if (ev.type === 'concat') {
                exportJob.progress = 0.95;
                exportJob.message = 'Zusammenfügen…';
              } else if (ev.type === 'done') {
                exportJob.progress = 1;
                exportJob.message = `Fertig: ${ev.output}`;
                exportJob.log.push(`done ${(ev.size / 1e6).toFixed(1)} MB`);
              } else if (ev.type === 'info') {
                exportJob.log.push(ev.message);
              }
            },
          });
          if (session.projectId && session.takeId) {
            try {
              const { take } = loadTake(session.projectId, session.takeId);
              take.final = {
                ...take.final,
                path: output,
                width,
                height,
                size: fs.existsSync(output) ? fs.statSync(output).size : null,
              };
              take.status = 'done';
              saveTake(session.projectId, take);
            } catch {
              /* ignore */
            }
          }
          exportJob.running = false;
          exportJob.finishedAt = new Date().toISOString();
          exportJob.progress = 1;
        } catch (err) {
          exportJob.running = false;
          exportJob.error = String(err.message || err);
          exportJob.message = `Fehler: ${exportJob.error}`;
          exportJob.finishedAt = new Date().toISOString();
          exportJob.log.push(exportJob.message);
        }
      });
      return;
    }

    res.writeHead(404).end('Not found');
  } catch (err) {
    const code = /nicht gefunden|not found|Kein /i.test(String(err.message)) ? 404 : 500;
    json(res, code, { ok: false, error: String(err.message || err) });
  }
});

server.listen(opts.port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${opts.port}/`;
  console.log(`App:      ${url}`);
  console.log(`Editor:   ${url}edit`);
  console.log(`Root:     ${getInstaRoot()}`);
  if (session.videoPath) console.log(`Video:    ${session.videoPath}`);
  if (session.projectId) console.log(`Take:     ${session.projectId}/${session.takeId}`);
  console.log(`Presets:  ${PRESETS_PATH}`);
  if (opts.open) openBrowser(url);
});
