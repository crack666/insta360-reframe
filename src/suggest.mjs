/**
 * Semi-auto angle suggestions from equirect proxy.
 *
 * Signals (each toggleable via opts):
 *  - calm: relative-low motion windows → pausePreset (selfie)
 *  - valley: short local motion minima (noisy — off by default)
 *  - skin: periodic selfie-sector skin scan
 *  - spike: motion spikes as review markers
 */
import { spawn } from 'node:child_process';
import { probeDuration } from './ffmpeg.mjs';
import { loadPresets, v360Filter } from './presets.mjs';
import { normalizeSegments, serializeTimeline, setRange } from './timeline.mjs';

function mad(a, b) {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return sum / n;
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const i = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor((sortedAsc.length - 1) * p)));
  return sortedAsc[i];
}

function skinRatio(rgb) {
  let skin = 0;
  let total = 0;
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    const r = rgb[i];
    const g = rgb[i + 1];
    const b = rgb[i + 2];
    total++;
    if (r > 60 && g > 30 && b > 20 && r > g && r > b && r - g > 10 && Math.abs(g - b) < 50) {
      skin++;
    }
  }
  return total ? skin / total : 0;
}

function runBinary(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`${cmd} exited ${code}\n${stderr.slice(-1500)}`));
    });
  });
}

async function extractMotionSeries(videoPath, { fps = 2, width = 160 } = {}) {
  const one = await runBinary('ffmpeg', [
    '-v', 'error',
    '-i', videoPath,
    '-vf', `fps=${fps},scale=${width}:-1,format=gray`,
    '-frames:v', '1',
    '-f', 'rawvideo',
    '-pix_fmt', 'gray',
    'pipe:1',
  ]);
  const frameSize = one.length;
  if (!frameSize) throw new Error('Could not decode a sample frame for motion analysis');

  const buf = await runBinary('ffmpeg', [
    '-v', 'error',
    '-i', videoPath,
    '-vf', `fps=${fps},scale=${width}:-1,format=gray`,
    '-f', 'rawvideo',
    '-pix_fmt', 'gray',
    'pipe:1',
  ]);

  const nFrames = Math.floor(buf.length / frameSize);
  const scores = [];
  let prev = null;
  for (let i = 0; i < nFrames; i++) {
    const frame = buf.subarray(i * frameSize, (i + 1) * frameSize);
    const motion = prev ? mad(prev, frame) : 0;
    scores.push({ t: i / fps, motion });
    prev = frame;
  }
  return { scores, fps, frameSize };
}

async function selfieSkinAt(videoPath, t, view) {
  const filter = v360Filter(view, { width: 96, height: 96 });
  try {
    const buf = await runBinary('ffmpeg', [
      '-v', 'error',
      '-ss', String(Math.max(0, t)),
      '-i', videoPath,
      '-frames:v', '1',
      '-vf', filter,
      '-f', 'rawvideo',
      '-pix_fmt', 'rgb24',
      'pipe:1',
    ]);
    return skinRatio(buf);
  } catch {
    return 0;
  }
}

function pushUnique(list, item, mergeGap = 1.2) {
  const overlap = list.find((s) => {
    if (s.type !== item.type) return false;
    const a0 = s.start ?? s.at;
    const a1 = s.end ?? a0;
    const b0 = item.start ?? item.at;
    const b1 = item.end ?? b0;
    return !(b1 < a0 - mergeGap || b0 > a1 + mergeGap);
  });
  if (overlap && item.type === 'selfie') {
    overlap.start = Math.min(overlap.start, item.start);
    overlap.end = Math.max(overlap.end, item.end);
    overlap.confidence = Math.max(overlap.confidence || 0, item.confidence || 0);
    if ((item.skin || 0) > (overlap.skin || 0)) {
      overlap.skin = item.skin;
      overlap.reason = item.reason;
      overlap.source = item.source;
    }
    return;
  }
  if (!overlap) list.push(item);
}

function bool(v, fallback) {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v;
  if (v === '0' || v === 'false' || v === false) return false;
  return Boolean(v);
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {string} videoPath
 * @param {object} [opts]
 */
export async function analyzeSuggestions(videoPath, opts = {}) {
  const defaultPreset = opts.defaultPreset || 'forward';
  const pausePreset = opts.pausePreset || 'selfie';
  const fps = num(opts.fps, 2);

  const enableCalm = bool(opts.enableCalm, true);
  const enableValleys = bool(opts.enableValleys, false);
  const enableSkin = bool(opts.enableSkin, true);
  const enableSpikes = bool(opts.enableSpikes, true);

  // 0 = lax (more), 100 = strict (fewer calm hits)
  const calmStrictness = Math.max(0, Math.min(100, num(opts.calmStrictness, 45)));
  const minCalmSec = Math.max(0.8, num(opts.minCalmSec, 2));
  const minSkinPct = Math.max(0, Math.min(100, num(opts.minSkinPct, 10))) / 100;
  const skinStepSec = Math.max(1, num(opts.skinStepSec, 3));
  const minConfidence = Math.max(0, Math.min(1, num(opts.minConfidence, 0.45)));
  const proposedMinConfidence = Math.max(0, Math.min(1, num(opts.proposedMinConfidence, 0.55)));

  const duration = await probeDuration(videoPath);
  const presets = loadPresets();
  const selfieView = presets[pausePreset] || presets.selfie;

  const { scores } = await extractMotionSeries(videoPath, { fps, width: 160 });
  if (scores.length < 4) {
    return {
      duration,
      defaultPreset,
      options: opts,
      suggestions: [],
      proposed: [{ start: 0, end: duration, preset: defaultPreset }],
      proposedTimeline: serializeTimeline([{ start: 0, end: duration, preset: defaultPreset }]),
      motion: scores.map((s) => ({ t: s.t, motion: Number(s.motion.toFixed(2)) })),
    };
  }

  const motions = scores.map((s) => s.motion).filter((_, i) => i > 0);
  const sorted = [...motions].sort((a, b) => a - b);
  const median = percentile(sorted, 0.5) || 1;
  const p25 = percentile(sorted, 0.25);
  const p15 = percentile(sorted, 0.15);

  // Higher strictness → lower threshold multiplier → only calmer moments count
  const strictFactor = 1.15 - (calmStrictness / 100) * 0.75; // 1.15 … 0.40
  const pauseThresh = Math.max(2.5, Math.min(median * 0.7, p25 * 1.15) * strictFactor);
  const valleyThresh = Math.max(2.5, p15 * (0.85 + (1 - calmStrictness / 100) * 0.4));
  const spikeThresh = Math.max(pauseThresh * 1.8, median * 1.45);

  const suggestions = [];

  if (enableCalm) {
    let i = 1;
    while (i < scores.length) {
      if (scores[i].motion <= pauseThresh) {
        let j = i;
        while (j < scores.length && scores[j].motion <= pauseThresh) j++;
        const t0 = scores[i].t;
        const t1 = Math.min(duration, scores[Math.min(j, scores.length - 1)].t + 1 / fps);
        const dur = t1 - t0;
        if (dur >= minCalmSec) {
          const mid = (t0 + t1) / 2;
          let skin = 0;
          if (selfieView) skin = await selfieSkinAt(videoPath, mid, { ...selfieView, name: pausePreset });
          const conf = Math.min(0.95, 0.4 + Math.min(dur, 8) * 0.05 + skin * 0.4);
          pushUnique(suggestions, {
            id: `calm-${Math.round(t0 * 10)}`,
            type: 'selfie',
            source: 'ruhe',
            start: Number(t0.toFixed(1)),
            end: Number(t1.toFixed(1)),
            preset: pausePreset,
            confidence: Number(conf.toFixed(2)),
            reason: skin > 0.06
              ? `Ruhig ${dur.toFixed(1)}s + Selfie-Sektor Haut~${Math.round(skin * 100)}%`
              : `Ruhiger Abschnitt ${dur.toFixed(1)}s (wenig Bildbewegung) → ${pausePreset}`,
            skin: Number(skin.toFixed(3)),
          });
        }
        i = j;
      } else {
        i++;
      }
    }
  }

  if (enableValleys) {
    for (let k = 2; k < scores.length - 2; k++) {
      const m = scores[k].motion;
      if (m > valleyThresh) continue;
      if (m >= scores[k - 1].motion || m >= scores[k + 1].motion) continue;
      const t0 = Math.max(0, scores[k].t - 0.8);
      const t1 = Math.min(duration, scores[k].t + 1.2);
      pushUnique(suggestions, {
        id: `valley-${Math.round(scores[k].t * 10)}`,
        type: 'selfie',
        source: 'tal',
        start: Number(t0.toFixed(1)),
        end: Number(t1.toFixed(1)),
        preset: pausePreset,
        confidence: 0.35,
        reason: `Kurzes Bewegungs-Tal @ ${scores[k].t.toFixed(1)}s (oft unspektakulär)`,
      }, 2.0);
    }
  }

  if (enableSkin && selfieView) {
    for (let t = 1; t < duration; t += skinStepSec) {
      const skin = await selfieSkinAt(videoPath, t, { ...selfieView, name: pausePreset });
      if (skin >= minSkinPct) {
        const t0 = Math.max(0, t - 1);
        const t1 = Math.min(duration, t + 2);
        pushUnique(suggestions, {
          id: `skin-${Math.round(t * 10)}`,
          type: 'selfie',
          source: 'haut',
          start: Number(t0.toFixed(1)),
          end: Number(t1.toFixed(1)),
          preset: pausePreset,
          confidence: Number(Math.min(0.92, 0.5 + skin).toFixed(2)),
          reason: `Selfie-Sektor: Hautanteil ~${Math.round(skin * 100)}% @ ${t.toFixed(1)}s`,
          skin: Number(skin.toFixed(3)),
        }, Math.max(2, skinStepSec));
      }
    }
  }

  if (enableSpikes) {
    for (let k = 2; k < scores.length - 1; k++) {
      const m = scores[k].motion;
      const prev = (scores[k - 1].motion + scores[k - 2].motion) / 2;
      if (m >= spikeThresh && m > prev * 1.35) {
        const t = scores[k].t;
        const inside = suggestions.some((s) => s.type === 'selfie' && t >= s.start && t <= s.end);
        if (!inside) {
          pushUnique(suggestions, {
            id: `spike-${Math.round(t * 10)}`,
            type: 'motion_spike',
            source: 'spike',
            at: Number(t.toFixed(1)),
            start: Number(t.toFixed(1)),
            end: Number(Math.min(t + 1.5, duration).toFixed(1)),
            preset: defaultPreset,
            confidence: 0.4,
            reason: 'Bewegungs-Spike — Hindernis / Richtungswechsel prüfen',
          }, 1.5);
        }
      }
    }
  }

  const filtered = suggestions
    .filter((s) => (s.confidence || 0) >= minConfidence)
    .sort((a, b) => (a.start ?? a.at) - (b.start ?? b.at));

  let proposed = normalizeSegments([], duration, defaultPreset);
  const forProposed = filtered
    .filter((x) => x.type === 'selfie')
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  const applied = [];
  for (const s of forProposed) {
    if ((s.confidence || 0) < proposedMinConfidence) continue;
    const clash = applied.some((a) => !(s.end <= a.start || s.start >= a.end));
    if (clash) continue;
    proposed = setRange(proposed, s.start, s.end, s.preset, duration, defaultPreset);
    applied.push(s);
  }

  return {
    duration,
    defaultPreset,
    pausePreset,
    options: {
      enableCalm,
      enableValleys,
      enableSkin,
      enableSpikes,
      calmStrictness,
      minCalmSec,
      minSkinPct: Math.round(minSkinPct * 100),
      skinStepSec,
      minConfidence,
      proposedMinConfidence,
    },
    pauseThresh: Number(pauseThresh.toFixed(2)),
    valleyThresh: Number(valleyThresh.toFixed(2)),
    spikeThresh: Number(spikeThresh.toFixed(2)),
    suggestions: filtered,
    proposed,
    proposedTimeline: serializeTimeline(proposed),
    motion: scores.map((s) => ({ t: Number(s.t.toFixed(2)), motion: Number(s.motion.toFixed(2)) })),
  };
}
