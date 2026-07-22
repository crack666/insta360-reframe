import * as THREE from 'three';

const deg = (d) => (d * Math.PI) / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmtTime = (s) => {
  if (!Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

const el = {
  view: document.getElementById('view'),
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
  markIn: document.getElementById('markIn'),
  markOut: document.getElementById('markOut'),
  timeline: document.getElementById('timeline'),
  copyTimeline: document.getElementById('copyTimeline'),
  copyCmd: document.getElementById('copyCmd'),
  cmd: document.getElementById('cmd'),
  status: document.getElementById('status'),
};

/** @type {Record<string, {yaw:number,pitch:number,h_fov:number,v_fov?:number,roll?:number,label:string}>} */
let PRESETS = {};

const state = {
  yaw: 0,
  pitch: 0,
  fov: 90,
  preset: 'forward',
  markIn: 0,
  dragging: false,
  lastX: 0,
  lastY: 0,
};

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
scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: texture })));

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
  updateCmd();
  highlightPreset();
}

function resize() {
  const w = el.view.clientWidth;
  const h = el.view.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
}

function tick() {
  if (video.duration && !el.seek.matches(':active')) {
    el.seek.value = String(Math.round((video.currentTime / video.duration) * 1000));
    el.timeVal.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;
  }
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
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
}

function updateCmd() {
  const tl = el.timeline.value.trim().replace(/\s+/g, '');
  const base = 'node src/cli.mjs -i <equirect.mp4> -o flat.mp4';
  el.cmd.textContent = tl
    ? `${base} -t "${tl}"`
    : `${base} -p ${state.preset}`;
}

function nearestPresetName() {
  let best = state.preset;
  let bestDist = Infinity;
  for (const [name, p] of Object.entries(PRESETS)) {
    const d = Math.abs(p.yaw - state.yaw) + Math.abs(p.pitch - state.pitch) * 0.5;
    if (d < bestDist) {
      bestDist = d;
      best = name;
    }
  }
  return bestDist < 15 ? best : state.preset;
}

function addSegment(t0, t1) {
  const use = nearestPresetName();
  const line = `${t0.toFixed(1)}-${t1.toFixed(1)}=${use}`;
  const cur = el.timeline.value.trim();
  el.timeline.value = cur ? `${cur.replace(/,?\s*$/, '')},\n${line}` : line;
  updateCmd();
}

function rebuildPresetUi() {
  el.presets.innerHTML = '';
  el.saveTarget.innerHTML = '';
  for (const [name, p] of Object.entries(PRESETS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = p.label || name;
    b.title = `${name}: yaw=${p.yaw} pitch=${p.pitch} fov=${p.h_fov}`;
    b.dataset.preset = name;
    b.addEventListener('click', () => setPreset(name));
    el.presets.appendChild(b);

    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = `${name} (${p.label || name})`;
    el.saveTarget.appendChild(opt);
  }
  if (PRESETS[state.preset]) el.saveTarget.value = state.preset;
  highlightPreset();
}

async function loadPresetsFromServer() {
  const r = await fetch('/api/presets', { cache: 'no-store' });
  if (!r.ok) throw new Error(`presets HTTP ${r.status}`);
  const doc = await r.json();
  PRESETS = doc.presets || {};
  el.presetPath.textContent = doc.path
    ? `Persisted: ${doc.path}`
    : 'Persisted: presets.json';
  rebuildPresetUi();
  if (PRESETS.forward) setPreset('forward');
  else {
    const first = Object.keys(PRESETS)[0];
    if (first) setPreset(first);
  }
}

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
});

el.play.addEventListener('click', () => {
  if (video.paused) video.play().catch(() => {});
  else video.pause();
});

el.markIn.addEventListener('click', () => {
  state.markIn = video.currentTime || 0;
  el.status.textContent = `Mark In @ ${fmtTime(state.markIn)}`;
});

el.markOut.addEventListener('click', () => {
  const t1 = video.currentTime || 0;
  const t0 = state.markIn;
  if (t1 <= t0) {
    el.status.textContent = 'Mark Out must be after Mark In';
    return;
  }
  addSegment(t0, t1);
  state.markIn = t1;
  el.status.textContent = `Added ${fmtTime(t0)}–${fmtTime(t1)} → Mark In moved to Out`;
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
  el.status.textContent = `Saved ${name}: yaw=${body.yaw} pitch=${body.pitch} fov=${body.h_fov} → presets.json (CLI uses this)`;
});

el.reloadPresets.addEventListener('click', async () => {
  await loadPresetsFromServer();
  el.status.textContent = 'Presets reloaded from disk';
});

el.copyTimeline.addEventListener('click', async () => {
  await navigator.clipboard.writeText(el.timeline.value.trim().replace(/\n/g, ''));
  el.status.textContent = 'Timeline copied';
});
el.copyCmd.addEventListener('click', async () => {
  await navigator.clipboard.writeText(el.cmd.textContent);
  el.status.textContent = 'CLI command copied';
});
el.timeline.addEventListener('input', updateCmd);

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

window.addEventListener('resize', resize);

video.addEventListener('loadedmetadata', () => {
  el.status.textContent = `Ready · ${fmtTime(video.duration)} · drag to look · save presets when tuned`;
  resize();
  video.play().catch(() => {});
});
video.addEventListener('error', () => {
  el.status.textContent = 'Video failed to load — is the preview server running with --video?';
});

fetch('/api/info')
  .then((r) => r.json())
  .then((info) => {
    if (info.presetsPath) el.presetPath.textContent = `Persisted: ${info.presetsPath}`;
  })
  .catch(() => {});

loadPresetsFromServer()
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
