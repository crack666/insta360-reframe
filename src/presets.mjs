/**
 * Shared presets — source of truth: ../presets.json (preview + CLI).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PRESETS_PATH = path.resolve(__dirname, '..', 'presets.json');

const FALLBACK = {
  forward: { yaw: 0, pitch: -8, roll: 0, h_fov: 90, v_fov: 70, label: 'forward' },
  selfie: { yaw: 70, pitch: 46, roll: 0, h_fov: 90, v_fov: 65, label: 'selfie' },
  up: { yaw: 0, pitch: 55, roll: 0, h_fov: 85, v_fov: 65, label: 'up' },
  left: { yaw: -90, pitch: -5, roll: 0, h_fov: 90, v_fov: 70, label: 'left' },
  right: { yaw: 90, pitch: -5, roll: 0, h_fov: 90, v_fov: 70, label: 'right' },
  back: { yaw: 180, pitch: -5, roll: 0, h_fov: 90, v_fov: 70, label: 'back' },
};

function normalizePreset(name, raw = {}) {
  return {
    yaw: Number(raw.yaw) || 0,
    pitch: Number(raw.pitch) || 0,
    roll: Number(raw.roll) || 0,
    h_fov: Number(raw.h_fov) || 90,
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

export function v360Filter(view, { width = 1280, height = 720 } = {}) {
  const { yaw, pitch, roll, h_fov, v_fov } = view;
  return [
    `v360=input=e:output=flat`,
    `yaw=${yaw}`,
    `pitch=${pitch}`,
    `roll=${roll ?? 0}`,
    `h_fov=${h_fov}`,
    `v_fov=${v_fov ?? 70}`,
    `w=${width}`,
    `h=${height}`,
  ].join(':');
}
