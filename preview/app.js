import * as THREE from 'three';

const deg = (d) => (d * Math.PI) / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmtTime = (s) => {
  if (!Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

const PRESET_COLORS = {
  forward: '#3d9cf0',
  selfie: '#e07a5f',
  up: '#81b29a',
  left: '#9b7ebd',
  right: '#f2cc8f',
  back: '#6c757d',
  custom: '#9aa0a8',
};
const PEEK_NAMES = ['forward', 'selfie', 'left', 'right'];
const DEFAULT_PRESET = 'forward';

const el = {
  view: document.getElementById('view'),
  peek: document.getElementById('peek'),
  presets: document.getElementById('presets'),
  saveTarget: document.getElementById('saveTarget'),
  savePreset: document.getElementById('savePreset'),
  reloadPresets: document.getElementById('reloadPresets'),
  presetPath: document.getElementById('presetPath'),
  yaw: document.getElementById('yaw'),
  pitch: document.getElementById('pitch'),
  fov: document.getElementById('fov'),
  yawVal: document.getElementById('yawVal'),
  pitchVal: document.getElementById('pitchVal'),
  fovVal: document.getElementById('fovVal'),
  seek: document.getElementById('seek'),
  timeVal: document.getElementById('timeVal'),
  play: document.getElementById('play'),
  scrubCanvas: document.getElementById('scrubCanvas'),
  timeline: document.getElementById('timeline'),
  segList: document.getElementById('segList'),
  suggestList: document.getElementById('suggestList'),
  copyTimeline: document.getElementById('copyTimeline'),
  copyCmd: document.getElementById('copyCmd'),
  saveTimeline: document.getElementById('saveTimeline'),
  reloadTimeline: document.getElementById('reloadTimeline'),
  timelinePath: document.getElementById('timelinePath'),
  autoSaveTimeline: document.getElementById('autoSaveTimeline'),
  resetTimeline: document.getElementById('resetTimeline'),
  removeCut: document.getElementById('removeCut'),
  cutHere: document.getElementById('cutHere'),
  cutCustom: document.getElementById('cutCustom'),
  cutForward: document.getElementById('cutForward'),
  cutSelfie: document.getElementById('cutSelfie'),
  analyze: document.getElementById('analyze'),
  acceptPauses: document.getElementById('acceptPauses'),
  applyProposed: document.getElementById('applyProposed'),
  optCalm: document.getElementById('optCalm'),
  optValleys: document.getElementById('optValleys'),
  optSkin: document.getElementById('optSkin'),
  optSpikes: document.getElementById('optSpikes'),
  optStrict: document.getElementById('optStrict'),
  optStrictVal: document.getElementById('optStrictVal'),
  optMinCalm: document.getElementById('optMinCalm'),
  optMinCalmVal: document.getElementById('optMinCalmVal'),
  optMinSkin: document.getElementById('optMinSkin'),
  optMinSkinVal: document.getElementById('optMinSkinVal'),
  optMinConf: document.getElementById('optMinConf'),
  optMinConfVal: document.getElementById('optMinConfVal'),
  cmd: document.getElementById('cmd'),
  status: document.getElementById('status'),
  videoName: document.getElementById('videoName'),
  activeSeg: document.getElementById('activeSeg'),
  rates: document.getElementById('rates'),
};

/** @type {Record<string, {yaw:number,pitch:number,h_fov:number,v_fov?:number,roll?:number,label:string}>} */
let PRESETS = {};
/** @type {{start:number,end:number,preset:string}[]} */
let segments = [];
/** @type {{start:number,end:number,preset:string}[]|null} */
let pendingTimeline = null;
/** @type {any[]} */
let suggestions = [];
/** @type {{start:number,end:number,preset:string}[]|null} */
let proposedSegments = null;
/** @type {Set<string>} */
const dismissed = new Set();
let timelineDirty = false;
let timelineSavePath = '';
let autoSaveTimer = null;

const state = {
  yaw: 0,
  pitch: 0,
  fov: 90,
  preset: DEFAULT_PRESET,
  dragging: false,
  lastX: 0,
  lastY: 0,
  duration: 0,
  rate: 1,
  /** last playhead time we synced view from */
  followT: -1,
  /** timeline preset last applied to the view */
  followPreset: null,
};

// —— Timeline helpers (mirror server; supports custom@yaw,pitch,fov) ——
function cloneSeg(s) {
  const out = {
    start: s.start,
    end: s.end,
    preset: String(s.preset || DEFAULT_PRESET).toLowerCase(),
  };
  if (out.preset === 'custom') {
    out.yaw = Number(s.yaw) || 0;
    out.pitch = Number(s.pitch) || 0;
    out.h_fov = Number(s.h_fov ?? s.fov) || 90;
    out.roll = Number(s.roll) || 0;
  }
  return out;
}

function sameView(a, b) {
  if (!a || !b || a.preset !== b.preset) return false;
  if (a.preset === 'custom') {
    return a.yaw === b.yaw && a.pitch === b.pitch && a.h_fov === b.h_fov;
  }
  return true;
}

function mergeAdjacent(list, eps = 0.05) {
  if (!list.length) return [];
  const out = [cloneSeg(list[0])];
  for (let i = 1; i < list.length; i++) {
    const prev = out[out.length - 1];
    const cur = cloneSeg(list[i]);
    if (sameView(prev, cur) && Math.abs(prev.end - cur.start) <= eps) prev.end = cur.end;
    else out.push(cur);
  }
  return out;
}

function normalizeSegments(list, durationSec, defaultPreset = DEFAULT_PRESET) {
  const dur = Math.max(0, durationSec);
  if (!dur) return [];
  let sorted = (list || [])
    .map((s) => cloneSeg({
      ...s,
      start: Math.max(0, s.start),
      end: Math.min(dur, s.end == null ? dur : s.end),
    }))
    .filter((s) => s.end - s.start > 0.02)
    .sort((a, b) => a.start - b.start);
  if (!sorted.length) return [{ start: 0, end: dur, preset: defaultPreset }];
  const filled = [];
  let cursor = 0;
  for (const s of sorted) {
    if (s.start > cursor + 0.02) filled.push({ start: cursor, end: s.start, preset: defaultPreset });
    const start = Math.max(s.start, cursor);
    if (s.end > start + 0.02) filled.push(cloneSeg({ ...s, start, end: s.end }));
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < dur - 0.02) filled.push({ start: cursor, end: dur, preset: defaultPreset });
  return mergeAdjacent(filled);
}

function asPatch(presetOrView) {
  if (presetOrView && typeof presetOrView === 'object') {
    return cloneSeg({ start: 0, end: 1, preset: 'custom', ...presetOrView, preset: 'custom' });
  }
  return { preset: String(presetOrView || DEFAULT_PRESET).toLowerCase() };
}

function switchAt(list, t, presetOrView, durationSec) {
  let segs = normalizeSegments(list, durationSec);
  t = clamp(Number(t) || 0, 0, durationSec);
  const eps = 0.05;
  const patch = asPatch(presetOrView);
  const out = [];
  for (const s of segs) {
    if (s.end <= t + eps) { out.push(s); continue; }
    if (s.start >= t - eps) { out.push(s); continue; }
    if (t - s.start > eps) out.push(cloneSeg({ ...s, end: t }));
    if (s.end - t > eps) out.push(cloneSeg({ ...patch, start: t, end: s.end }));
  }
  return mergeAdjacent(out);
}

function setRange(list, t0, t1, presetOrView, durationSec) {
  const patch = asPatch(presetOrView);
  let a = clamp(Number(t0) || 0, 0, durationSec);
  let b = clamp(Number(t1) || 0, 0, durationSec);
  if (b <= a + 0.05) return normalizeSegments(list, durationSec);
  let segs = normalizeSegments(list, durationSec);
  const out = [];
  for (const s of segs) {
    if (s.end <= a || s.start >= b) { out.push(s); continue; }
    if (s.start < a) out.push(cloneSeg({ ...s, end: a }));
    const mid0 = Math.max(s.start, a);
    const mid1 = Math.min(s.end, b);
    if (mid1 > mid0) out.push(cloneSeg({ ...patch, start: mid0, end: mid1 }));
    if (s.end > b) out.push(cloneSeg({ ...s, start: b }));
  }
  return mergeAdjacent(out);
}

function removeCutNear(list, t, durationSec, tol = 0.75) {
  let segs = normalizeSegments(list, durationSec);
  if (segs.length < 2) return segs;
  let best = -1;
  let bestDist = Infinity;
  for (let i = 1; i < segs.length; i++) {
    const d = Math.abs(segs[i].start - t);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  if (best < 1 || bestDist > tol) return segs;
  segs[best - 1] = cloneSeg({ ...segs[best - 1], end: segs[best].end });
  segs.splice(best, 1);
  return mergeAdjacent(segs);
}

function segmentAt(list, t) {
  for (const s of list) {
    if (t >= s.start - 1e-6 && t < s.end - 1e-6) return s;
  }
  if (list.length && Math.abs(t - list[list.length - 1].end) < 1e-3) return list[list.length - 1];
  return { start: 0, end: 0, preset: DEFAULT_PRESET };
}

function presetAt(list, t) {
  return segmentAt(list, t).preset;
}

function formatViewToken(s) {
  if (s.preset === 'custom') {
    return `custom@${Math.round(s.yaw)}/${Math.round(s.pitch)}/${Math.round(s.h_fov)}`;
  }
  return s.preset;
}

function serializeTimeline(list) {
  return list.map((s) => `${Number(s.start.toFixed(1))}-${Number(s.end.toFixed(1))}=${formatViewToken(s)}`).join(',');
}

function parseViewToken(token) {
  const raw = String(token).trim();
  const lower = raw.toLowerCase();
  if (lower === 'custom' || lower.startsWith('custom@')) {
    const body = lower.startsWith('custom@') ? raw.slice(raw.indexOf('@') + 1) : '';
    const view = { preset: 'custom', yaw: 0, pitch: 0, h_fov: 90 };
    if (/^-?\d+(\.\d+)?\/-?\d+(\.\d+)?\/-?\d+(\.\d+)?$/.test(body.trim())) {
      const [yaw, pitch, fov] = body.split('/').map(Number);
      view.yaw = yaw;
      view.pitch = pitch;
      view.h_fov = fov;
      return view;
    }
    for (const part of body.split(/[;,]/)) {
      const p = part.trim();
      if (!p) continue;
      const eq = p.search(/[:=]/);
      if (eq < 0) continue;
      const key = p.slice(0, eq).trim().toLowerCase();
      const val = parseFloat(p.slice(eq + 1));
      if (!Number.isFinite(val)) continue;
      if (key === 'yaw' || key === 'y') view.yaw = val;
      else if (key === 'pitch' || key === 'p') view.pitch = val;
      else if (key === 'fov' || key === 'h_fov' || key === 'f') view.h_fov = val;
    }
    return view;
  }
  return { preset: lower };
}

function parseTimelineLoose(spec) {
  if (!spec || !String(spec).trim()) return [];
  return String(spec).split(/[,\n]+/).map((s) => s.trim()).filter(Boolean).map((chunk) => {
    const m = chunk.match(/^(.+?)-(.+?)=(.+)$/);
    if (!m) throw new Error(`Bad segment: ${chunk}`);
    const parseTs = (tok) => {
      const t = tok.trim().toLowerCase();
      if (t === 'end') return null;
      if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
      const parts = t.split(':').map(Number);
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      throw new Error(`Bad time: ${tok}`);
    };
    return {
      start: parseTs(m[1]),
      end: parseTs(m[2]),
      ...parseViewToken(m[3]),
    };
  }).map((s) => ({
    ...s,
    end: s.end == null ? state.duration : s.end,
  }));
}

function colorFor(name) {
  return PRESET_COLORS[name] || PRESET_COLORS.custom;
}

function segLabel(s) {
  if (s.preset === 'custom') {
    return `custom (${Math.round(s.yaw)}°/${Math.round(s.pitch)}°/${Math.round(s.h_fov)}°)`;
  }
  return s.preset;
}

// —— Three.js main view ——
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
el.view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(state.fov, 1, 0.1, 100);
camera.position.set(0, 0, 0.01);

const video = document.createElement('video');
video.crossOrigin = 'anonymous';
video.playsInline = true;
video.preload = 'auto';
video.src = '/media';
video.muted = true;

const texture = new THREE.VideoTexture(video);
texture.colorSpace = THREE.SRGBColorSpace;
texture.minFilter = THREE.LinearFilter;
texture.magFilter = THREE.LinearFilter;

const geo = new THREE.SphereGeometry(50, 64, 32);
geo.scale(-1, 1, 1);
const sphereMat = new THREE.MeshBasicMaterial({ map: texture });
scene.add(new THREE.Mesh(geo, sphereMat));

// Peek strip — shared texture, separate cameras
const peekViews = [];
function buildPeek() {
  el.peek.innerHTML = '';
  peekViews.length = 0;
  for (const name of PEEK_NAMES) {
    const card = document.createElement('div');
    card.className = 'peek-card';
    card.dataset.preset = name;
    const label = document.createElement('span');
    label.textContent = name;
    const canvas = document.createElement('canvas');
    card.appendChild(canvas);
    card.appendChild(label);
    card.addEventListener('click', () => {
      setPreset(name);
      doCut(name);
    });
    el.peek.appendChild(card);

    const r = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
    r.setPixelRatio(1);
    const cam = new THREE.PerspectiveCamera(90, 16 / 9, 0.1, 100);
    cam.position.set(0, 0, 0.01);
    peekViews.push({ name, card, renderer: r, camera: cam });
  }
}

function applyPeekCameras() {
  for (const pv of peekViews) {
    const p = PRESETS[pv.name];
    if (!p) continue;
    pv.camera.rotation.order = 'YXZ';
    pv.camera.rotation.y = deg(-p.yaw);
    pv.camera.rotation.x = deg(p.pitch);
    pv.camera.fov = p.h_fov;
    pv.camera.updateProjectionMatrix();
    pv.card.classList.toggle('active', state.preset === pv.name);
  }
}

function applyLook() {
  camera.rotation.order = 'YXZ';
  camera.rotation.y = deg(-state.yaw);
  camera.rotation.x = deg(state.pitch);
  camera.fov = state.fov;
  camera.updateProjectionMatrix();
  el.yaw.value = String(state.yaw);
  el.pitch.value = String(state.pitch);
  el.fov.value = String(state.fov);
  el.yawVal.textContent = String(Math.round(state.yaw));
  el.pitchVal.textContent = String(Math.round(state.pitch));
  el.fovVal.textContent = String(Math.round(state.fov));
  highlightPreset();
  applyPeekCameras();
  updateCmd();
}

function resize() {
  const w = el.view.clientWidth;
  const h = el.view.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
  for (const pv of peekViews) {
    const cw = pv.card.clientWidth || 160;
    const ch = pv.card.clientHeight || 90;
    pv.renderer.setSize(cw, ch, false);
    pv.camera.aspect = cw / Math.max(ch, 1);
    pv.camera.updateProjectionMatrix();
  }
  drawScrubber();
}

function tick() {
  if (video.duration && !el.seek.matches(':active')) {
    el.seek.value = String(Math.round((video.currentTime / video.duration) * 1000));
    el.timeVal.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;
    el.play.textContent = video.paused ? 'Play' : 'Pause';
    syncViewToPlayhead();
  }
  renderer.render(scene, camera);
  for (const pv of peekViews) {
    pv.renderer.render(scene, pv.camera);
  }
  requestAnimationFrame(tick);
}

/**
 * Keep Blickrichtung in sync with the timeline segment under the playhead.
 * Runs when time moves (play/scrub/jump) or segment at playhead changes.
 */
function syncViewToPlayhead({ force = false } = {}) {
  if (!state.duration && !video.duration) return;
  const t = video.currentTime || 0;
  const seg = segmentAt(segments, t);
  const name = seg.preset;
  const key = name === 'custom'
    ? `custom:${Math.round(seg.yaw)}:${Math.round(seg.pitch)}:${Math.round(seg.h_fov)}`
    : name;
  const timeMoved = Math.abs(t - state.followT) > 0.03;
  const segChanged = key !== state.followPreset;
  if (!force && !timeMoved && !segChanged) {
    if (el.activeSeg) el.activeSeg.textContent = `jetzt: ${segLabel(seg)}`;
    return;
  }
  state.followT = t;
  state.followPreset = key;
  if (el.activeSeg) el.activeSeg.textContent = `jetzt: ${segLabel(seg)}`;
  applySegmentLook(seg);
}

/** Apply named preset or custom segment angles to the main view. */
function applySegmentLook(seg) {
  if (!seg) return;
  if (seg.preset === 'custom') {
    state.preset = 'custom';
    state.yaw = Number(seg.yaw) || 0;
    state.pitch = Number(seg.pitch) || 0;
    state.fov = Number(seg.h_fov) || 90;
    applyLook();
    return;
  }
  if (PRESETS[seg.preset]) setPreset(seg.preset);
}

function setPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  state.preset = name;
  state.yaw = p.yaw;
  state.pitch = p.pitch;
  state.fov = p.h_fov;
  if (el.saveTarget) el.saveTarget.value = name;
  applyLook();
}

function highlightPreset() {
  for (const btn of el.presets.querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.preset === state.preset);
  }
  if (el.cutCustom) el.cutCustom.classList.toggle('active', state.preset === 'custom');
}

function nearestPresetName() {
  let best = null;
  let bestDist = Infinity;
  for (const [name, p] of Object.entries(PRESETS)) {
    const d = Math.abs(p.yaw - state.yaw) + Math.abs(p.pitch - state.pitch) * 0.5;
    if (d < bestDist) { bestDist = d; best = name; }
  }
  return bestDist < 15 ? best : 'custom';
}

function syncFromSegments({ markDirty = true } = {}) {
  segments = normalizeSegments(segments, state.duration || video.duration || 0);
  el.timeline.value = segments.map((s) => `${s.start.toFixed(1)}-${s.end.toFixed(1)}=${formatViewToken(s)}`).join(',\n');
  renderSegList();
  drawScrubber();
  updateCmd();
  syncViewToPlayhead({ force: true });
  if (markDirty) {
    timelineDirty = true;
    updateTimelinePathUi();
    scheduleAutoSave();
  }
}

function updateTimelinePathUi() {
  if (!el.timelinePath) return;
  const dirty = timelineDirty ? ' · ungespeichert' : '';
  if (timelineSavePath) {
    el.timelinePath.textContent = `Gespeichert: ${timelineSavePath}${dirty}`;
  } else {
    el.timelinePath.textContent = timelineDirty
      ? 'Noch nicht gespeichert — „Timeline speichern“ oder Auto-Save'
      : 'Noch keine Timeline-Datei';
  }
}

function scheduleAutoSave() {
  if (!el.autoSaveTimeline?.checked) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    saveTimelineToServer({ quiet: true }).catch(() => {});
  }, 600);
}

async function saveTimelineToServer({ quiet = false } = {}) {
  const r = await fetch('/api/timeline', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ segments, timeline: serializeTimeline(segments) }),
  });
  const doc = await r.json();
  if (!r.ok || !doc.ok) {
    if (!quiet) el.status.textContent = `Speichern fehlgeschlagen: ${doc.error || r.status}`;
    throw new Error(doc.error || String(r.status));
  }
  timelineDirty = false;
  timelineSavePath = doc.path || timelineSavePath;
  updateTimelinePathUi();
  if (!quiet) {
    el.status.textContent = `Timeline gespeichert (${segments.length} Segmente) → ${doc.path}`;
  }
  return doc;
}

async function loadTimelineFromServer({ announce = true } = {}) {
  const r = await fetch('/api/timeline', { cache: 'no-store' });
  if (!r.ok) return false;
  const doc = await r.json();
  if (doc.path) timelineSavePath = doc.path;
  if (!doc.segments?.length) {
    updateTimelinePathUi();
    return false;
  }
  const dur = state.duration || video.duration || 0;
  if (dur > 0) {
    segments = normalizeSegments(doc.segments, dur);
    syncFromSegments({ markDirty: false });
    timelineDirty = false;
    updateTimelinePathUi();
    if (announce) el.status.textContent = `Timeline geladen (${segments.length} Segmente)`;
  } else {
    pendingTimeline = doc.segments;
    updateTimelinePathUi();
    if (announce) el.status.textContent = 'Timeline gefunden — warte auf Video-Metadaten…';
  }
  return true;
}

function updateCmd() {
  const tl = serializeTimeline(segments);
  const base = 'node src/cli.mjs -i <equirect.mp4> -o flat.mp4';
  el.cmd.textContent = tl ? `${base} -t "${tl}"` : `${base} -p ${state.preset}`;
}

function renderSegList() {
  el.segList.innerHTML = '';
  for (const s of segments) {
    const row = document.createElement('div');
    row.className = 'seg-item';
    row.innerHTML = `
      <div class="swatch" style="background:${colorFor(s.preset)}"></div>
      <div class="meta"><div class="name">${segLabel(s)}</div>
      <div>${fmtTime(s.start)} – ${fmtTime(s.end)}</div></div>
      <button type="button" data-act="jump">Gehe hin</button>`;
    row.querySelector('[data-act="jump"]').addEventListener('click', (e) => {
      e.stopPropagation();
      video.currentTime = s.start + 0.05;
      syncViewToPlayhead({ force: true });
    });
    row.addEventListener('click', () => {
      video.currentTime = s.start + 0.05;
      syncViewToPlayhead({ force: true });
    });
    el.segList.appendChild(row);
  }
}

function drawScrubber() {
  const canvas = el.scrubCanvas;
  const wrap = canvas.parentElement;
  const w = wrap.clientWidth || 300;
  canvas.width = w * devicePixelRatio;
  canvas.height = 28 * devicePixelRatio;
  canvas.style.width = `${w}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, w, 28);
  ctx.fillStyle = '#0e1118';
  ctx.fillRect(0, 0, w, 28);
  const dur = state.duration || video.duration || 1;
  for (const s of segments) {
    const x0 = (s.start / dur) * w;
    const x1 = (s.end / dur) * w;
    ctx.fillStyle = colorFor(s.preset);
    ctx.globalAlpha = 0.85;
    ctx.fillRect(x0, 4, Math.max(2, x1 - x0), 20);
  }
  ctx.globalAlpha = 1;
  for (const s of suggestions) {
    if (dismissed.has(s.id)) continue;
    if (isSelfieSuggestion(s)) {
      const x0 = (s.start / dur) * w;
      const x1 = (s.end / dur) * w;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(x0, 2, Math.max(2, x1 - x0), 24);
      ctx.setLineDash([]);
    } else if (s.type === 'motion_spike') {
      const x = ((s.at ?? s.start) / dur) * w;
      ctx.fillStyle = '#f2cc8f';
      ctx.fillRect(x - 1, 0, 2, 28);
    }
  }
  const t = video.currentTime || 0;
  const px = (t / dur) * w;
  ctx.fillStyle = '#fff';
  ctx.fillRect(px - 1, 0, 2, 28);
}

function isSelfieSuggestion(s) {
  return s.type === 'selfie' || s.type === 'pause';
}

function suggestBadge(s) {
  const src = s.source || (s.type === 'motion_spike' ? 'spike' : 'ruhe');
  return src;
}

const SOURCE_LABEL = {
  haut: 'Selfie-Check',
  ruhe: 'Ruhe',
  tal: 'Bewegungs-Tal',
  spike: 'Spike',
  pause: 'Ruhe',
  selfie: 'Selfie',
};

function renderSuggestions() {
  el.suggestList.innerHTML = '';
  const visible = suggestions.filter((s) => !dismissed.has(s.id));
  if (!visible.length) {
    el.suggestList.innerHTML = '<p class="hint">Noch keine Vorschläge — Parameter anpassen &amp; „Video analysieren“.</p>';
    return;
  }
  for (const s of visible) {
    const item = document.createElement('div');
    item.className = 'suggest-item';
    const src = suggestBadge(s);
    const label = SOURCE_LABEL[src] || src;
    const confPct = Math.round((s.confidence || 0) * 100);
    const range = isSelfieSuggestion(s)
      ? `${fmtTime(s.start)} – ${fmtTime(s.end)} → ${s.preset}`
      : `@ ${fmtTime(s.at ?? s.start)}`;
    const skinPct = Number.isFinite(s.skin) ? Math.round(s.skin * 100) : null;
    const triggerHint = src === 'haut' && skinPct != null
      ? `Trigger: Hautfarbe ${skinPct}% ≥ Min. Hautanteil (Slider). „${confPct}% sicher“ = Confidence.`
      : src === 'ruhe'
        ? `Trigger: ruhiger Abschnitt (wenig Frame-Differenz) ≥ Min. Ruhe-Dauer. „${confPct}% sicher“ = Confidence.`
        : src === 'tal'
          ? `Trigger: kurzes Bewegungs-Tal (oft Noise). „${confPct}% sicher“ = Confidence.`
          : `Trigger: Bewegungs-Spike. „${confPct}% sicher“ = Confidence.`;
    item.innerHTML = `
      <div class="top">
        <strong>${range}</strong>
        <span class="badge ${src}" title="${triggerHint}">${label} · ${confPct}% sicher</span>
      </div>
      <div class="reason">${s.reason || ''}</div>
      <div class="actions"></div>`;
    const actions = item.querySelector('.actions');
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.textContent = 'Ansehen';
    jump.addEventListener('click', () => {
      video.currentTime = s.start ?? s.at ?? 0;
      if (s.preset && PRESETS[s.preset]) setPreset(s.preset);
    });
    actions.appendChild(jump);
    if (isSelfieSuggestion(s)) {
      const acc = document.createElement('button');
      acc.type = 'button';
      acc.className = 'accept';
      acc.textContent = 'Übernehmen';
      acc.addEventListener('click', () => acceptSuggestion(s));
      actions.appendChild(acc);
    }
    const rej = document.createElement('button');
    rej.type = 'button';
    rej.className = 'reject';
    rej.textContent = 'Verwerfen';
    rej.addEventListener('click', () => {
      dismissed.add(s.id);
      restoreTimelineView();
      renderSuggestions();
      drawScrubber();
      el.status.textContent = `Verworfen · Ansicht → ${presetAt(segments, video.currentTime || 0)}`;
    });
    actions.appendChild(rej);
    el.suggestList.appendChild(item);
  }
}

/** Snap look to the timeline preset at the current playhead. */
function restoreTimelineView() {
  syncViewToPlayhead({ force: true });
}

function acceptSuggestion(s) {
  if (!isSelfieSuggestion(s)) return;
  segments = setRange(segments, s.start, s.end, s.preset, state.duration);
  dismissed.add(s.id);
  syncFromSegments();
  restoreTimelineView();
  renderSuggestions();
  el.status.textContent = `Übernommen: ${fmtTime(s.start)}–${fmtTime(s.end)} = ${s.preset}`;
}

function doCut(presetOrView) {
  const t = video.currentTime || 0;
  let patch = presetOrView;
  let label;
  if (patch && typeof patch === 'object') {
    patch = {
      yaw: Math.round(patch.yaw),
      pitch: Math.round(patch.pitch),
      h_fov: Math.round(patch.h_fov ?? patch.fov ?? state.fov),
    };
    label = `custom (${patch.yaw}°/${patch.pitch}°/${patch.h_fov}°)`;
  } else {
    const name = patch || state.preset || nearestPresetName();
    if (name === 'custom') {
      doCut({ yaw: state.yaw, pitch: state.pitch, h_fov: state.fov });
      return;
    }
    patch = name;
    label = name;
  }
  segments = switchAt(segments, t, patch, state.duration);
  syncFromSegments();
  el.status.textContent = `Cut @ ${fmtTime(t)} → ${label}`;
}

function doCutCustom() {
  doCut({ yaw: state.yaw, pitch: state.pitch, h_fov: state.fov });
}

function rebuildPresetUi() {
  el.presets.innerHTML = '';
  el.saveTarget.innerHTML = '';
  for (const [name, p] of Object.entries(PRESETS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = p.label || name;
    b.title = `${name}: yaw=${p.yaw} pitch=${p.pitch} · Klick=ansehen, Doppelklick=Cut`;
    b.dataset.preset = name;
    b.addEventListener('click', () => setPreset(name));
    b.addEventListener('dblclick', () => doCut(name));
    el.presets.appendChild(b);
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    el.saveTarget.appendChild(opt);
  }
  if (PRESETS[state.preset]) el.saveTarget.value = state.preset;
  highlightPreset();
  applyPeekCameras();
}

async function loadPresetsFromServer() {
  const r = await fetch('/api/presets', { cache: 'no-store' });
  if (!r.ok) throw new Error(`presets HTTP ${r.status}`);
  const doc = await r.json();
  PRESETS = doc.presets || {};
  el.presetPath.textContent = doc.path ? `Datei: ${doc.path}` : 'presets.json';
  rebuildPresetUi();
  if (PRESETS[DEFAULT_PRESET]) setPreset(DEFAULT_PRESET);
  else {
    const first = Object.keys(PRESETS)[0];
    if (first) setPreset(first);
  }
}

// —— Events ——
el.yaw.addEventListener('input', () => {
  state.yaw = Number(el.yaw.value);
  state.preset = nearestPresetName();
  applyLook();
});
el.pitch.addEventListener('input', () => {
  state.pitch = Number(el.pitch.value);
  state.preset = nearestPresetName();
  applyLook();
});
el.fov.addEventListener('input', () => {
  state.fov = Number(el.fov.value);
  applyLook();
});

el.seek.addEventListener('input', () => {
  if (!video.duration) return;
  video.currentTime = (Number(el.seek.value) / 1000) * video.duration;
  syncViewToPlayhead({ force: true });
  drawScrubber();
});

el.play.addEventListener('click', () => {
  if (video.paused) video.play().catch(() => {});
  else video.pause();
});

el.rates.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-rate]');
  if (!btn) return;
  state.rate = Number(btn.dataset.rate);
  video.playbackRate = state.rate;
  for (const b of el.rates.querySelectorAll('button')) {
    b.classList.toggle('active', b === btn);
  }
});

el.cutHere.addEventListener('click', () => doCut(state.preset));
el.cutCustom.addEventListener('click', () => doCutCustom());
el.cutForward.addEventListener('click', () => doCut('forward'));
el.cutSelfie.addEventListener('click', () => doCut('selfie'));
el.removeCut.addEventListener('click', () => {
  segments = removeCutNear(segments, video.currentTime || 0, state.duration);
  syncFromSegments();
  el.status.textContent = 'Nächsten Cut am Playhead entfernt (falls vorhanden)';
});
el.resetTimeline.addEventListener('click', () => {
  segments = [{ start: 0, end: state.duration, preset: DEFAULT_PRESET }];
  syncFromSegments();
  el.status.textContent = 'Timeline: nur forward';
});

el.timeline.addEventListener('change', () => {
  try {
    segments = normalizeSegments(parseTimelineLoose(el.timeline.value), state.duration);
    syncFromSegments();
  } catch (err) {
    el.status.textContent = String(err.message || err);
  }
});

el.savePreset.addEventListener('click', async () => {
  const name = el.saveTarget.value;
  if (!name) return;
  const body = {
    yaw: Math.round(state.yaw),
    pitch: Math.round(state.pitch),
    h_fov: Math.round(state.fov),
    v_fov: PRESETS[name]?.v_fov ?? 70,
    roll: 0,
    label: PRESETS[name]?.label || name,
  };
  const r = await fetch(`/api/presets/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const doc = await r.json();
  if (!r.ok || !doc.ok) {
    el.status.textContent = `Save failed: ${doc.error || r.status}`;
    return;
  }
  PRESETS[name] = doc.preset;
  state.preset = name;
  rebuildPresetUi();
  applyLook();
  el.status.textContent = `Gespeichert ${name}: yaw=${body.yaw} pitch=${body.pitch}`;
});

el.reloadPresets.addEventListener('click', async () => {
  await loadPresetsFromServer();
  el.status.textContent = 'Presets neu geladen';
});

el.copyTimeline.addEventListener('click', async () => {
  await navigator.clipboard.writeText(serializeTimeline(segments));
  el.status.textContent = 'Timeline kopiert';
});
el.copyCmd.addEventListener('click', async () => {
  await navigator.clipboard.writeText(el.cmd.textContent);
  el.status.textContent = 'CLI kopiert';
});
el.saveTimeline.addEventListener('click', async () => {
  try {
    await saveTimelineToServer({ quiet: false });
  } catch (err) {
    el.status.textContent = `Speichern fehlgeschlagen: ${err.message || err}`;
  }
});
el.reloadTimeline.addEventListener('click', async () => {
  try {
    const ok = await loadTimelineFromServer({ announce: true });
    if (!ok) el.status.textContent = 'Keine gespeicherte Timeline für dieses Video';
  } catch (err) {
    el.status.textContent = `Laden fehlgeschlagen: ${err.message || err}`;
  }
});

function readAnalyzeOptions() {
  return {
    enableCalm: el.optCalm.checked,
    enableValleys: el.optValleys.checked,
    enableSkin: el.optSkin.checked,
    enableSpikes: el.optSpikes.checked,
    calmStrictness: Number(el.optStrict.value),
    minCalmSec: Number(el.optMinCalm.value),
    minSkinPct: Number(el.optMinSkin.value),
    minConfidence: Number(el.optMinConf.value) / 100,
    proposedMinConfidence: Math.max(0.45, Number(el.optMinConf.value) / 100 + 0.05),
  };
}

function bindAnalyzeOptionLabels() {
  const sync = () => {
    el.optStrictVal.textContent = el.optStrict.value;
    el.optMinCalmVal.textContent = el.optMinCalm.value;
    el.optMinSkinVal.textContent = el.optMinSkin.value;
    el.optMinConfVal.textContent = el.optMinConf.value;
  };
  for (const id of ['optStrict', 'optMinCalm', 'optMinSkin', 'optMinConf']) {
    el[id].addEventListener('input', sync);
  }
  sync();
}

el.analyze.addEventListener('click', async () => {
  el.analyze.disabled = true;
  const opts = readAnalyzeOptions();
  el.status.textContent = 'Analysiere… (Parameter werden mitgeschickt)';
  try {
    const r = await fetch('/api/suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    const doc = await r.json();
    if (!r.ok || !doc.ok) throw new Error(doc.error || r.status);
    suggestions = doc.suggestions || [];
    proposedSegments = doc.proposed || null;
    dismissed.clear();
    renderSuggestions();
    drawScrubber();
    const nSelfie = suggestions.filter(isSelfieSuggestion).length;
    el.status.textContent = `Fertig: ${nSelfie} Selfie-Vorschläge, ${suggestions.length - nSelfie} Spikes`
      + (doc.options ? ` · Strenge ${doc.options.calmStrictness}` : '');
  } catch (err) {
    el.status.textContent = `Analyse fehlgeschlagen: ${err.message || err}`;
  } finally {
    el.analyze.disabled = false;
  }
});

el.acceptPauses.addEventListener('click', () => {
  for (const s of suggestions.filter((x) => isSelfieSuggestion(x) && !dismissed.has(x.id))) {
    acceptSuggestion(s);
  }
  el.status.textContent = 'Alle Selfie-Vorschläge übernommen';
});

el.applyProposed.addEventListener('click', () => {
  if (!proposedSegments?.length) {
    el.status.textContent = 'Keine Vorschlags-Timeline — zuerst analysieren';
    return;
  }
  segments = normalizeSegments(proposedSegments, state.duration);
  for (const s of suggestions.filter(isSelfieSuggestion)) dismissed.add(s.id);
  syncFromSegments();
  renderSuggestions();
  el.status.textContent = 'Vorschlags-Timeline geladen (nur höhere Confidence)';
});

bindAnalyzeOptionLabels();

el.view.addEventListener('pointerdown', (e) => {
  state.dragging = true;
  state.lastX = e.clientX;
  state.lastY = e.clientY;
  el.view.setPointerCapture(e.pointerId);
});
el.view.addEventListener('pointerup', () => { state.dragging = false; });
el.view.addEventListener('pointermove', (e) => {
  if (!state.dragging) return;
  const dx = e.clientX - state.lastX;
  const dy = e.clientY - state.lastY;
  state.lastX = e.clientX;
  state.lastY = e.clientY;
  state.yaw = ((state.yaw - dx * 0.25 + 540) % 360) - 180;
  state.pitch = clamp(state.pitch + dy * 0.2, -89, 89);
  state.preset = nearestPresetName();
  applyLook();
});
el.view.addEventListener('wheel', (e) => {
  e.preventDefault();
  state.fov = clamp(state.fov + Math.sign(e.deltaY) * 3, 40, 120);
  applyLook();
}, { passive: false });

window.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  } else if (e.key === 'c' || e.key === 'C') {
    e.preventDefault();
    doCut(state.preset === 'custom'
      ? { yaw: state.yaw, pitch: state.pitch, h_fov: state.fov }
      : state.preset);
  } else if (e.key === 'x' || e.key === 'X') {
    e.preventDefault();
    doCutCustom();
  } else if (e.key === 'f' || e.key === 'F') {
    doCut('forward');
  } else if (e.key === 's' || e.key === 'S') {
    doCut('selfie');
  } else if (e.key === '1') {
    state.rate = 1; video.playbackRate = 1;
  } else if (e.key === '2') {
    state.rate = 2; video.playbackRate = 2;
  } else if (e.key === '4') {
    state.rate = 4; video.playbackRate = 4;
  } else if (e.key === '[') {
    video.currentTime = Math.max(0, (video.currentTime || 0) - 5);
    syncViewToPlayhead({ force: true });
  } else if (e.key === ']') {
    video.currentTime = Math.min(state.duration, (video.currentTime || 0) + 5);
    syncViewToPlayhead({ force: true });
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    segments = removeCutNear(segments, video.currentTime || 0, state.duration);
    syncFromSegments();
    syncViewToPlayhead({ force: true });
  }
  for (const b of el.rates.querySelectorAll('button')) {
    b.classList.toggle('active', Number(b.dataset.rate) === state.rate);
  }
  drawScrubber();
});

window.addEventListener('resize', resize);
video.addEventListener('timeupdate', () => {
  syncViewToPlayhead();
  drawScrubber();
});

video.addEventListener('loadedmetadata', async () => {
  state.duration = video.duration || 0;
  if (pendingTimeline?.length) {
    segments = normalizeSegments(pendingTimeline, state.duration);
    pendingTimeline = null;
    syncFromSegments({ markDirty: false });
    timelineDirty = false;
    updateTimelinePathUi();
    el.status.textContent = `Ready · Timeline geladen (${segments.length} Segmente) · ${fmtTime(state.duration)}`;
  } else if (!segments.length) {
    segments = [{ start: 0, end: state.duration, preset: DEFAULT_PRESET }];
    syncFromSegments({ markDirty: false });
    el.status.textContent = `Ready · ${fmtTime(state.duration)} · Blick folgt Timeline · C = Cut · Auto-Save an`;
  } else {
    segments = normalizeSegments(segments, state.duration);
    syncFromSegments({ markDirty: false });
    el.status.textContent = `Ready · ${fmtTime(state.duration)} · ${segments.length} Segmente`;
  }
  syncViewToPlayhead({ force: true });
  resize();
  video.play().catch(() => {});
});
video.addEventListener('error', () => {
  el.status.textContent = 'Video fehlgeschlagen — läuft der Preview-Server mit --video?';
});

buildPeek();

fetch('/api/info')
  .then((r) => r.json())
  .then((info) => {
    if (info.name) el.videoName.textContent = info.name;
    if (info.presetsPath) el.presetPath.textContent = `Datei: ${info.presetsPath}`;
    if (info.timelinePath) {
      timelineSavePath = info.timelinePath;
      updateTimelinePathUi();
    }
  })
  .catch(() => {});

loadPresetsFromServer()
  .then(() => loadTimelineFromServer({ announce: false }))
  .then(() => {
    resize();
    applyLook();
    tick();
  })
  .catch((err) => {
    el.status.textContent = `Preset load failed: ${err.message}`;
    resize();
    applyLook();
    tick();
  });
