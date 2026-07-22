#!/usr/bin/env node
/**
 * Local preview server for equirect MP4 + shared presets API.
 *
 *   node src/preview-server.mjs --video path/to/equirect.mp4
 *   → http://127.0.0.1:8787/
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
import { listEncoders } from './ffmpeg.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PREVIEW = path.join(ROOT, 'preview');

function timelinePathFor(video) {
  return `${video}.timeline.json`;
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
  const opts = { video: null, port: 8787, open: true };
  const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--video' || a[i] === '-v') opts.video = a[++i];
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

const opts = parseArgs(process.argv);
if (!opts.video) {
  console.error('Usage: node src/preview-server.mjs --video <equirect.mp4> [--port 8787]');
  process.exit(1);
}
const videoPath = path.resolve(opts.video);
if (!fs.existsSync(videoPath)) {
  console.error(`Video not found: ${videoPath}`);
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const method = req.method || 'GET';

  try {
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

    if (url.pathname === '/' || url.pathname === '/index.html') {
      sendFile(res, path.join(PREVIEW, 'index.html'), req);
      return;
    }
    if (url.pathname.startsWith('/preview/')) {
      sendFile(res, path.join(PREVIEW, url.pathname.slice('/preview/'.length)), req);
      return;
    }
    if (url.pathname === '/media') {
      sendFile(res, videoPath, req);
      return;
    }
    if (url.pathname === '/api/info') {
      json(res, 200, {
        video: videoPath,
        name: path.basename(videoPath),
        size: fs.statSync(videoPath).size,
        presetsPath: PRESETS_PATH,
        timelinePath: timelinePathFor(videoPath),
      });
      return;
    }

    if (url.pathname === '/api/timeline' && method === 'GET') {
      const p = timelinePathFor(videoPath);
      if (!fs.existsSync(p)) {
        json(res, 200, { ok: true, segments: [], path: p });
        return;
      }
      const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
      json(res, 200, { ok: true, ...doc, path: p });
      return;
    }

    if (url.pathname === '/api/timeline' && method === 'PUT') {
      const body = JSON.parse(await readBody(req));
      const p = timelinePathFor(videoPath);
      let segments = Array.isArray(body.segments) ? body.segments : [];
      if (!segments.length && body.timeline) {
        segments = parseTimeline(body.timeline);
      }
      const timelineStr = body.timeline || serializeTimeline(segments);
      const out = {
        version: 1,
        video: videoPath,
        timeline: timelineStr,
        segments,
        updated: new Date().toISOString(),
      };
      fs.writeFileSync(p, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
      // CLI-friendly companion (same folder)
      const txtPath = `${videoPath}.timeline.txt`;
      fs.writeFileSync(txtPath, `${timelineStr.replace(/,/g, '\n')}\n`, 'utf8');
      json(res, 200, { ok: true, path: p, txtPath, ...out });
      return;
    }

    if (url.pathname === '/api/suggest' && method === 'POST') {
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
      const encoders = await listEncoders();
      const base = path.basename(videoPath, path.extname(videoPath));
      const defaultOut = path.join(path.dirname(videoPath), `${base}_flat.mp4`);
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
          { id: 'draft', label: 'Draft (schnell)' },
          { id: 'medium', label: 'Medium' },
          { id: 'high', label: 'High' },
        ],
        defaultOutput: defaultOut,
      });
      return;
    }

    if (url.pathname === '/api/export/status' && method === 'GET') {
      json(res, 200, { ok: true, ...exportJob, log: exportJob.log.slice(-40) });
      return;
    }

    if (url.pathname === '/api/export' && method === 'POST') {
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

      // Persist timeline first if provided
      if (Array.isArray(body.segments) && body.segments.length) {
        const p = timelinePathFor(videoPath);
        const timelineStr = body.timeline || serializeTimeline(body.segments);
        const doc = {
          version: 1,
          video: videoPath,
          timeline: timelineStr,
          segments: body.segments,
          updated: new Date().toISOString(),
        };
        fs.writeFileSync(p, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
        fs.writeFileSync(`${videoPath}.timeline.txt`, `${timelineStr.replace(/,/g, '\n')}\n`, 'utf8');
      }

      const base = path.basename(videoPath, path.extname(videoPath));
      const output = path.resolve(
        body.output || path.join(path.dirname(videoPath), `${base}_flat.mp4`),
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

      // Run async after response
      setImmediate(async () => {
        try {
          await exportFlat({
            input: videoPath,
            output,
            segments: body.segments,
            width,
            height,
            codec: body.codec || 'h264',
            quality: body.quality || 'medium',
            bitrate: body.bitrate || null,
            audioBitrate: body.audioBitrate || '160k',
            onProgress: (ev) => {
              if (ev.type === 'start') {
                exportJob.message = `${ev.width}×${ev.height} · ${ev.encoder} · ${ev.segments} Segmente`;
                exportJob.log.push(exportJob.message);
                exportJob.progress = 0.02;
              } else if (ev.type === 'segment') {
                exportJob.progress = (ev.index + 0.5) / Math.max(ev.total, 1);
                exportJob.message = `Segment ${ev.index + 1}/${ev.total}: ${ev.preset}` +
                  (ev.lens !== 'default' ? `+${ev.lens}` : '');
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
    json(res, 500, { ok: false, error: String(err.message || err) });
  }
});

server.listen(opts.port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${opts.port}/`;
  console.log(`Preview:  ${url}`);
  console.log(`Video:    ${videoPath}`);
  console.log(`Presets:  ${PRESETS_PATH}`);
  if (opts.open) openBrowser(url);
});
