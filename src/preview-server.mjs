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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PREVIEW = path.join(ROOT, 'preview');

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
