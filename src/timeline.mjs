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
