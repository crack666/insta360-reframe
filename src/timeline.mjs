/**
 * Timeline parsing: "start-end=preset" segments (comma or newline separated).
 * Times: seconds, or mm:ss, or hh:mm:ss. "end" = until source end.
 *
 * Named presets:
 *   0-120=forward,120-150=selfie
 *
 * Custom look (inline angles, not a saved preset):
 *   40-48=custom@yaw:70,pitch:20,fov:90
 */

export function parseTimestamp(token, { allowEnd = false } = {}) {
  const t = String(token).trim().toLowerCase();
  if (allowEnd && t === 'end') return null;
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  const parts = t.split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) {
    throw new Error(`Bad timestamp: ${token}`);
  }
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  throw new Error(`Bad timestamp: ${token}`);
}

function parseViewToken(token) {
  const raw = String(token).trim();
  const lower = raw.toLowerCase();
  if (lower === 'custom' || lower.startsWith('custom@')) {
    const body = lower.startsWith('custom@') ? raw.slice(raw.indexOf('@') + 1) : '';
    const view = { preset: 'custom', yaw: 0, pitch: 0, h_fov: 90, roll: 0 };
    for (const part of body.split(',')) {
      const p = part.trim();
      if (!p) continue;
      const eq = p.indexOf(':');
      if (eq < 0) continue;
      const key = p.slice(0, eq).trim().toLowerCase();
      const val = parseFloat(p.slice(eq + 1));
      if (!Number.isFinite(val)) continue;
      if (key === 'yaw') view.yaw = val;
      else if (key === 'pitch') view.pitch = val;
      else if (key === 'fov' || key === 'h_fov') view.h_fov = val;
      else if (key === 'roll') view.roll = val;
      else if (key === 'v_fov') view.v_fov = val;
    }
    return view;
  }
  return { preset: lower };
}

function cloneSeg(s) {
  const out = {
    start: s.start,
    end: s.end,
    preset: String(s.preset || 'forward').toLowerCase(),
  };
  if (out.preset === 'custom') {
    out.yaw = Number(s.yaw) || 0;
    out.pitch = Number(s.pitch) || 0;
    out.h_fov = Number(s.h_fov ?? s.fov) || 90;
    out.roll = Number(s.roll) || 0;
    if (s.v_fov != null) out.v_fov = Number(s.v_fov);
  }
  return out;
}

export function sameView(a, b) {
  if (!a || !b) return false;
  if (a.preset !== b.preset) return false;
  if (a.preset === 'custom') {
    return a.yaw === b.yaw && a.pitch === b.pitch
      && a.h_fov === b.h_fov && (a.roll || 0) === (b.roll || 0);
  }
  return true;
}

/**
 * @returns {{ start: number, end: number|null, preset: string, yaw?: number, pitch?: number, h_fov?: number }[]}
 */
export function parseTimeline(spec) {
  if (!spec || !String(spec).trim()) return [];
  const chunks = String(spec)
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  return chunks.map((chunk, i) => {
    const m = chunk.match(/^(.+?)-(.+?)=(.+)$/);
    if (!m) {
      throw new Error(
        `Bad segment #${i + 1}: "${chunk}" (expected start-end=preset or custom@yaw:…,pitch:…,fov:…)`,
      );
    }
    const start = parseTimestamp(m[1]);
    const end = parseTimestamp(m[2], { allowEnd: true });
    if (end != null && end <= start) {
      throw new Error(`Segment #${i + 1}: end must be > start (${chunk})`);
    }
    return { start, end, ...parseViewToken(m[3]) };
  });
}

/** Fill null ends with duration; validate coverage optionally. */
export function resolveTimeline(segments, durationSec) {
  if (!segments.length) {
    return [{ start: 0, end: durationSec, preset: 'forward' }];
  }
  return segments.map((s) => cloneSeg({
    ...s,
    end: s.end == null ? durationSec : Math.min(s.end, durationSec),
  })).filter((s) => s.end > s.start);
}

export function formatTimestamp(sec) {
  if (!Number.isFinite(sec)) return '0';
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(s % 1 ? 1 : 0)}`;
  }
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const sStr = s.toFixed(s % 1 ? 1 : 0);
  return `${m}:${sStr.padStart(s % 1 ? 4 : 2, '0')}`;
}

function formatViewToken(s) {
  if (s.preset === 'custom') {
    return `custom@yaw:${Math.round(s.yaw)},pitch:${Math.round(s.pitch)},fov:${Math.round(s.h_fov)}`;
  }
  return s.preset;
}

/** Serialize segments for CLI `-t`. */
export function serializeTimeline(segments, { precision = 1 } = {}) {
  return segments
    .map((s) => {
      const a = Number(s.start.toFixed(precision));
      const b = Number(s.end.toFixed(precision));
      return `${a}-${b}=${formatViewToken(s)}`;
    })
    .join(',');
}

function mergeAdjacent(segments, eps = 0.05) {
  if (!segments.length) return [];
  const out = [cloneSeg(segments[0])];
  for (let i = 1; i < segments.length; i++) {
    const prev = out[out.length - 1];
    const cur = cloneSeg(segments[i]);
    if (sameView(prev, cur) && Math.abs(prev.end - cur.start) <= eps) {
      prev.end = cur.end;
    } else {
      out.push(cur);
    }
  }
  return out;
}

/**
 * Ensure contiguous coverage 0…duration with defaultPreset in gaps.
 */
export function normalizeSegments(segments, durationSec, defaultPreset = 'forward') {
  const dur = Math.max(0, durationSec);
  if (!dur) return [];
  let list = (segments || [])
    .map((s) => cloneSeg({
      ...s,
      start: Math.max(0, s.start),
      end: Math.min(dur, s.end == null ? dur : s.end),
    }))
    .filter((s) => s.end - s.start > 0.02)
    .sort((a, b) => a.start - b.start);

  if (!list.length) {
    return [{ start: 0, end: dur, preset: defaultPreset }];
  }

  const filled = [];
  let cursor = 0;
  for (const s of list) {
    if (s.start > cursor + 0.02) {
      filled.push({ start: cursor, end: s.start, preset: defaultPreset });
    }
    const start = Math.max(s.start, cursor);
    if (s.end > start + 0.02) filled.push(cloneSeg({ ...s, start, end: s.end }));
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < dur - 0.02) {
    filled.push({ start: cursor, end: dur, preset: defaultPreset });
  }
  return mergeAdjacent(filled);
}

function asPatch(presetOrView) {
  if (presetOrView && typeof presetOrView === 'object') {
    return cloneSeg({ start: 0, end: 1, preset: 'custom', ...presetOrView, preset: 'custom' });
  }
  return { preset: String(presetOrView || 'forward').toLowerCase() };
}

/**
 * Live-switcher cut: at time t, change the remainder of the *current* segment.
 * `presetOrView`: preset name string, or `{ yaw, pitch, h_fov }` for custom.
 */
export function switchAt(segments, t, presetOrView, durationSec, defaultPreset = 'forward') {
  const dur = Math.max(0, durationSec);
  const patch = asPatch(presetOrView);
  let segs = normalizeSegments(segments, dur, defaultPreset);
  t = Math.max(0, Math.min(Number(t) || 0, dur));
  const eps = 0.05;
  const out = [];
  for (const s of segs) {
    if (s.end <= t + eps) {
      out.push(s);
      continue;
    }
    if (s.start >= t - eps) {
      out.push(s);
      continue;
    }
    if (t - s.start > eps) out.push(cloneSeg({ ...s, end: t }));
    if (s.end - t > eps) out.push(cloneSeg({ ...patch, start: t, end: s.end }));
  }
  return mergeAdjacent(out);
}

/**
 * Set only [t0, t1) to preset/view; leave the rest unchanged.
 */
export function setRange(segments, t0, t1, presetOrView, durationSec, defaultPreset = 'forward') {
  const dur = Math.max(0, durationSec);
  const patch = asPatch(presetOrView);
  let a = Math.max(0, Math.min(Number(t0) || 0, dur));
  let b = Math.max(0, Math.min(Number(t1) || 0, dur));
  if (b <= a + 0.05) return normalizeSegments(segments, dur, defaultPreset);
  let segs = normalizeSegments(segments, dur, defaultPreset);
  const out = [];
  for (const s of segs) {
    if (s.end <= a || s.start >= b) {
      out.push(s);
      continue;
    }
    if (s.start < a) out.push(cloneSeg({ ...s, end: a }));
    const mid0 = Math.max(s.start, a);
    const mid1 = Math.min(s.end, b);
    if (mid1 > mid0) out.push(cloneSeg({ ...patch, start: mid0, end: mid1 }));
    if (s.end > b) out.push(cloneSeg({ ...s, start: b }));
  }
  return mergeAdjacent(out);
}

/** Segment covering time t. */
export function segmentAt(segments, t, defaultPreset = 'forward') {
  for (const s of segments) {
    if (t >= s.start - 1e-6 && t < s.end - 1e-6) return s;
  }
  if (segments.length && Math.abs(t - segments[segments.length - 1].end) < 1e-3) {
    return segments[segments.length - 1];
  }
  return { start: 0, end: 0, preset: defaultPreset };
}

/** Preset name active at time t. */
export function presetAt(segments, t, defaultPreset = 'forward') {
  return segmentAt(segments, t, defaultPreset).preset;
}

/** Remove the cut at/near t (merge with previous). */
export function removeCutNear(segments, t, durationSec, defaultPreset = 'forward', tol = 0.75) {
  let segs = normalizeSegments(segments, durationSec, defaultPreset);
  if (segs.length < 2) return segs;
  let best = -1;
  let bestDist = Infinity;
  for (let i = 1; i < segs.length; i++) {
    const d = Math.abs(segs[i].start - t);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  if (best < 1 || bestDist > tol) return segs;
  segs[best - 1] = cloneSeg({
    ...segs[best - 1],
    end: segs[best].end,
  });
  segs.splice(best, 1);
  return mergeAdjacent(segs);
}
