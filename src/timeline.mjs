/**
 * Timeline parsing: "start-end=preset" segments (comma or newline separated).
 * Times: seconds, or mm:ss, or hh:mm:ss. "end" = until source end.
 *
 * Example:
 *   0-120=forward,120-150=selfie,150-end=forward
 */

export function parseTimestamp(token, { allowEnd = false } = {}) {
  const t = String(token).trim().toLowerCase();
  if (allowEnd && t === 'end') return null; // resolved later
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  const parts = t.split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) {
    throw new Error(`Bad timestamp: ${token}`);
  }
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  throw new Error(`Bad timestamp: ${token}`);
}

/**
 * @returns {{ start: number, end: number|null, preset: string }[]}
 */
export function parseTimeline(spec) {
  if (!spec || !String(spec).trim()) return [];
  const chunks = String(spec)
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  return chunks.map((chunk, i) => {
    const m = chunk.match(/^(.+?)-(.+?)=([a-zA-Z_][\w-]*)$/);
    if (!m) {
      throw new Error(
        `Bad segment #${i + 1}: "${chunk}" (expected start-end=preset, e.g. 0:00-2:00=forward)`,
      );
    }
    const start = parseTimestamp(m[1]);
    const end = parseTimestamp(m[2], { allowEnd: true });
    if (end != null && end <= start) {
      throw new Error(`Segment #${i + 1}: end must be > start (${chunk})`);
    }
    return { start, end, preset: m[3].toLowerCase() };
  });
}

/** Fill null ends with duration; validate coverage optionally. */
export function resolveTimeline(segments, durationSec) {
  if (!segments.length) {
    return [{ start: 0, end: durationSec, preset: 'forward' }];
  }
  return segments.map((s) => ({
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

/** Serialize segments for CLI `-t`. */
export function serializeTimeline(segments, { precision = 1 } = {}) {
  return segments
    .map((s) => {
      const a = Number(s.start.toFixed(precision));
      const b = Number(s.end.toFixed(precision));
      return `${a}-${b}=${s.preset}`;
    })
    .join(',');
}

function mergeAdjacent(segments, eps = 0.05) {
  if (!segments.length) return [];
  const out = [{ ...segments[0] }];
  for (let i = 1; i < segments.length; i++) {
    const prev = out[out.length - 1];
    const cur = segments[i];
    if (prev.preset === cur.preset && Math.abs(prev.end - cur.start) <= eps) {
      prev.end = cur.end;
    } else {
      out.push({ ...cur });
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
    .map((s) => ({
      start: Math.max(0, s.start),
      end: Math.min(dur, s.end == null ? dur : s.end),
      preset: String(s.preset || defaultPreset).toLowerCase(),
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
    if (s.end > start + 0.02) filled.push({ start, end: s.end, preset: s.preset });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < dur - 0.02) {
    filled.push({ start: cursor, end: dur, preset: defaultPreset });
  }
  return mergeAdjacent(filled);
}

/**
 * Live-switcher cut: at time t, change the remainder of the *current* segment to `preset`.
 * Later cut points stay intact.
 */
export function switchAt(segments, t, preset, durationSec, defaultPreset = 'forward') {
  const dur = Math.max(0, durationSec);
  const name = String(preset).toLowerCase();
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
    // s contains t
    if (t - s.start > eps) out.push({ start: s.start, end: t, preset: s.preset });
    if (s.end - t > eps) out.push({ start: t, end: s.end, preset: name });
  }
  return mergeAdjacent(out);
}

/**
 * Set only [t0, t1) to preset; leave the rest unchanged.
 */
export function setRange(segments, t0, t1, preset, durationSec, defaultPreset = 'forward') {
  const dur = Math.max(0, durationSec);
  const name = String(preset).toLowerCase();
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
    if (s.start < a) out.push({ start: s.start, end: a, preset: s.preset });
    const mid0 = Math.max(s.start, a);
    const mid1 = Math.min(s.end, b);
    if (mid1 > mid0) out.push({ start: mid0, end: mid1, preset: name });
    if (s.end > b) out.push({ start: b, end: s.end, preset: s.preset });
  }
  return mergeAdjacent(out);
}

/** Preset active at time t. */
export function presetAt(segments, t, defaultPreset = 'forward') {
  for (const s of segments) {
    if (t >= s.start - 1e-6 && t < s.end - 1e-6) return s.preset;
  }
  if (segments.length && Math.abs(t - segments[segments.length - 1].end) < 1e-3) {
    return segments[segments.length - 1].preset;
  }
  return defaultPreset;
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
  segs[best - 1] = {
    start: segs[best - 1].start,
    end: segs[best].end,
    preset: segs[best - 1].preset,
  };
  segs.splice(best, 1);
  return mergeAdjacent(segs);
}
