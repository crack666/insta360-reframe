import * as THREE from 'three';

/** Keep in sync with src/presets.mjs */
const PRESETS = {
  forward: { yaw: 0, pitch: -8, h_fov: 90, label: 'forward' },
  selfie: { yaw: 180, pitch: 35, h_fov: 85, label: 'selfie' },
  up: { yaw: 0, pitch: 55, h_fov: 85, label: 'up' },
  left: { yaw: -90, pitch: -5, h_fov: 90, label: 'left' },
  right: { yaw: 90, pitch: -5, h_fov: 90, label: 'right' },
  back: { yaw: 180, pitch: -5, h_fov: 90, label: 'back' },
};

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

const state = {
  yaw: 0,
  pitch: -8,
  fov: 90,
  preset: 'forward',
  markIn: 0,
  dragging: false,
  lastX: 0,
  lastY: 0,
};

// --- Three.js equirect video sphere ---
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
video.muted = true; // autoplay policies; unmute optional later

const texture = new THREE.VideoTexture(video);
texture.colorSpace = THREE.SRGBColorSpace;
texture.minFilter = THREE.LinearFilter;
texture.magFilter = THREE.LinearFilter;

// Inverted sphere: camera looks at inside of equirect map
const geo = new THREE.SphereGeometry(50, 64, 32);
geo.scale(-1, 1, 1);
const mat = new THREE.MeshBasicMaterial({ map: texture });
scene.add(new THREE.Mesh(geo, mat));

function applyLook() {
  // Match ffmpeg v360-ish: yaw around Y, pitch around X
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
    : `${base} -p ${state.preset} --yaw ${Math.round(state.yaw)} --pitch ${Math.round(state.pitch)} --fov ${Math.round(state.fov)}`;
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
  return bestDist < 25 ? best : `custom`;
}

function addSegment(t0, t1) {
  const name = nearestPresetName();
  const preset = name === 'custom' ? state.preset : name;
  // If custom far from presets, bake as forward with note — still use nearest named for CLI
  const use = PRESETS[preset] ? preset : 'forward';
  const line = `${t0.toFixed(1)}-${t1.toFixed(1)}=${use}`;
  const cur = el.timeline.value.trim();
  el.timeline.value = cur ? `${cur.replace(/,?\s*$/, '')},\n${line}` : line;
  updateCmd();
}

// Preset buttons
for (const [name, p] of Object.entries(PRESETS)) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = p.label;
  b.dataset.preset = name;
  b.addEventListener('click', () => setPreset(name));
  el.presets.appendChild(b);
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

el.copyTimeline.addEventListener('click', async () => {
  await navigator.clipboard.writeText(el.timeline.value.trim().replace(/\n/g, ''));
  el.status.textContent = 'Timeline copied';
});
el.copyCmd.addEventListener('click', async () => {
  await navigator.clipboard.writeText(el.cmd.textContent);
  el.status.textContent = 'CLI command copied';
});
el.timeline.addEventListener('input', updateCmd);

// Drag to look
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
  el.status.textContent = `Ready · ${fmtTime(video.duration)} · drag to look`;
  resize();
  setPreset('forward');
  video.play().catch(() => {
    el.status.textContent = 'Ready (press Play) · drag to look';
  });
});
video.addEventListener('error', () => {
  el.status.textContent = 'Video failed to load — is the preview server running with --video?';
});

fetch('/api/info')
  .then((r) => r.json())
  .then((info) => {
    el.status.textContent = `Source: ${info.name || info.video}`;
  })
  .catch(() => {});

resize();
applyLook();
tick();
