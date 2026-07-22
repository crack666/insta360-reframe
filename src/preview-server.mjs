#!/usr/bin/env node
/**
 * Local preview server for equirect MP4.
 *
 *   node src/preview-server.mjs --video path/to/equirect.mp4
 *   → http://127.0.0.1:8787/
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

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
  '.svg': 'image/svg+xml',
};

function sendFile(res, filePath, req) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404).end('Not found');
    return;
  }
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';

  // Range support for video seeking
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    sendFile(res, path.join(PREVIEW, 'index.html'), req);
    return;
  }
  if (url.pathname.startsWith('/preview/')) {
    const rel = url.pathname.slice('/preview/'.length);
    sendFile(res, path.join(PREVIEW, rel), req);
    return;
  }
  if (url.pathname === '/media') {
    sendFile(res, videoPath, req);
    return;
  }
  if (url.pathname === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      video: videoPath,
      name: path.basename(videoPath),
      size: fs.statSync(videoPath).size,
    }));
    return;
  }
  res.writeHead(404).end('Not found');
});

server.listen(opts.port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${opts.port}/`;
  console.log(`Preview: ${url}`);
  console.log(`Video:   ${videoPath}`);
  if (opts.open) openBrowser(url);
});
