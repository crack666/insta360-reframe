/**
 * Shared presets — source of truth: ../presets.json (preview + CLI).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PRESETS_PATH = path.resolve(__dirname, '..', 'presets.json');

const FALLBACK = {
  forward: { yaw: 0, pitch: -8, roll: 0, h_fov: 120, v_fov: 70, label: 'forward' },
  selfie: { yaw: 70, pitch: 46, roll: 0, h_fov: 120, v_fov: 65, label: 'selfie' },
  up: { yaw: 0, pitch: 55, roll: 0, h_fov: 115, v_fov: 65, label: 'up' },
  left: { yaw: -90, pitch: -5, roll: 0, h_fov: 120, v_fov: 70, label: 'left' },
  right: { yaw: 90, pitch: -5, roll: 0, h_fov: 120, v_fov: 70, label: 'right' },
  back: { yaw: 180, pitch: -5, roll: 0, h_fov: 120, v_fov: 70, label: 'back' },
};

function normalizePreset(name, raw = {}) {
  return {
    yaw: Number(raw.yaw) || 0,
    pitch: Number(raw.pitch) || 0,
    roll: Number(raw.roll) || 0,
    h_fov: Number(raw.h_fov) || 120,
    v_fov: Number(raw.v_fov) || 70,
    label: String(raw.label || name),
  };
}

export function loadPresetsDoc() {
  try {
    const doc = JSON.parse(fs.readFileSync(PRESETS_PATH, 'utf8'));
    const presets = {};
    const src = doc.presets && typeof doc.presets === 'object' ? doc.presets : doc;
    for (const [name, raw] of Object.entries(src)) {
      if (name === 'version' || name === 'note') continue;
      if (raw && typeof raw === 'object') presets[name] = normalizePreset(name, raw);
    }
    if (!Object.keys(presets).length) return { version: 1, presets: { ...FALLBACK } };
    return { version: doc.version || 1, note: doc.note || '', presets };
  } catch {
    return { version: 1, presets: { ...FALLBACK } };
  }
}

export function loadPresets() {
  return loadPresetsDoc().presets;
}

export function savePresetsDoc(doc) {
  const presets = {};
  for (const [name, raw] of Object.entries(doc.presets || {})) {
    presets[name] = normalizePreset(name, raw);
  }
  const out = {
    version: doc.version || 1,
    note: doc.note || 'Shared by preview UI and CLI export. Edit in preview (Save to preset) or by hand.',
    presets,
    updated: new Date().toISOString(),
  };
  fs.writeFileSync(PRESETS_PATH, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  return out;
}

export function updatePreset(name, partial) {
  const doc = loadPresetsDoc();
  const key = String(name).toLowerCase();
  const prev = doc.presets[key] || FALLBACK[key] || normalizePreset(key, {});
  doc.presets[key] = normalizePreset(key, { ...prev, ...partial, label: partial.label || prev.label || key });
  return savePresetsDoc(doc);
}

export function resolvePreset(name, presets = loadPresets()) {
  const key = String(name || '').toLowerCase();
  if (!presets[key]) {
    throw new Error(`Unknown preset "${name}". Available: ${Object.keys(presets).join(', ')}`);
  }
  return { name: key, ...presets[key] };
}

/**
 * Insta360-like "View Angle Gear" → FOV profile for flat reframe.
 * `default` = keep preset/custom FOV as stored.
 * Approximate Studio Linear / Ultra (not identical — Studio also changes projection feel).
 */
export const LENS_GEARS = {
  default: { id: 'default', label: 'Default', h_fov: null, v_fov: null },
  linear: { id: 'linear', label: 'Linear', h_fov: 95, v_fov: null },
  ultra: { id: 'ultra', label: 'Ultra', h_fov: 140, v_fov: null },
};

export function resolveLens(lens) {
  const key = String(lens || 'default').toLowerCase();
  return LENS_GEARS[key] || LENS_GEARS.default;
}

/**
 * Resolve full view for a timeline segment (named preset or custom + optional lens).
 */
export function resolveSegmentView(seg, presets = loadPresets()) {
  let view;
  if (seg.preset === 'custom') {
    view = {
      name: 'custom',
      yaw: Number(seg.yaw) || 0,
      pitch: Number(seg.pitch) || 0,
      roll: Number(seg.roll) || 0,
      h_fov: Number(seg.h_fov ?? seg.fov) || 90,
      v_fov: Number(seg.v_fov) || 70,
    };
  } else {
    view = resolvePreset(seg.preset, presets);
  }
  const lens = resolveLens(seg.lens);
  if (lens.h_fov != null) view = { ...view, h_fov: lens.h_fov };
  if (lens.v_fov != null) view = { ...view, v_fov: lens.v_fov };
  return { ...view, lens: lens.id };
}

/**
 * Convert UI / Three.js look angles to ffmpeg v360.
 * Preview uses inverted equirect sphere + rotation.y = -yaw; ffmpeg's yaw=0
 * points at equirect center — empirically needs +90° yaw to match the preview.
 */
export function toFfmpegView(view) {
  const yawUi = Number(view.yaw) || 0;
  const pitchUi = Number(view.pitch) || 0;
  let yaw = yawUi + 90;
  yaw = ((yaw + 540) % 360) - 180;
  return {
    ...view,
    yaw,
    pitch: pitchUi,
    roll: Number(view.roll) || 0,
  };
}

/** Horizontal FOV → vertical FOV for a rectilinear camera with given aspect (w/h). */
export function hfovToVfov(hfovDeg, aspect) {
  const h = (Number(hfovDeg) * Math.PI) / 180;
  const a = Math.max(Number(aspect) || 16 / 9, 0.05);
  const v = 2 * Math.atan(Math.tan(h / 2) / a);
  return (v * 180) / Math.PI;
}

export function v360Filter(view, { width = 1280, height = 720 } = {}) {
  const v = toFfmpegView(view);
  const hFov = Number(v.h_fov) || 120;
  // Match Three.js PerspectiveCamera: h_fov is source of truth, v_fov follows aspect.
  // (Presets may store a legacy v_fov; ignoring it avoids preview/export zoom mismatch.)
  const vFov = hfovToVfov(hFov, width / Math.max(height, 1));
  return [
    `v360=input=e:output=flat`,
    `yaw=${v.yaw}`,
    `pitch=${v.pitch}`,
    `roll=${v.roll ?? 0}`,
    `h_fov=${hFov}`,
    `v_fov=${vFov}`,
    `w=${width}`,
    `h=${height}`,
  ].join(':');
}
