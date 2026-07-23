/**
 * In-process async jobs for stitch / final (UI polling).
 */
import { randomUUID } from 'node:crypto';

/** @type {Map<string, object>} */
const jobs = new Map();

export function createJob(type, meta = {}) {
  const id = randomUUID().slice(0, 8);
  const job = {
    id,
    type,
    status: 'queued',
    progress: 0,
    message: 'Warteschlange…',
    log: [],
    error: null,
    result: null,
    meta,
    startedAt: null,
    finishedAt: null,
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function listJobs({ limit = 20, projectId = null, takeId = null, activeOnly = false } = {}) {
  let list = [...jobs.values()].reverse();
  if (projectId) list = list.filter((j) => j.meta?.projectId === projectId);
  if (takeId) list = list.filter((j) => j.meta?.takeId === takeId);
  if (activeOnly) list = list.filter((j) => j.status === 'queued' || j.status === 'running');
  return list.slice(0, limit);
}

/** Parse MediaSDK progress lines → 0..1 or null */
export function parseProgressLine(line) {
  const s = String(line || '');
  let m = s.match(/process\s*=\s*(\d+)\s*%/i);
  if (m) return Math.min(1, Math.max(0, Number(m[1]) / 100));
  m = s.match(/progress:\s*(\d+)\b/i);
  if (m) return Math.min(1, Math.max(0, Number(m[1]) / 100));
  return null;
}

export function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch);
  return job;
}

export function appendJobLog(id, line) {
  const job = jobs.get(id);
  if (!job || !line) return;
  const text = String(line).trim();
  if (!text) return;
  job.log.push(text);
  if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
}

export function startJob(id, runner) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  job.message = 'Läuft…';
  setImmediate(async () => {
    try {
      const result = await runner(job);
      job.result = result ?? null;
      job.status = 'done';
      job.progress = 1;
      job.message = job.message || 'Fertig';
      job.finishedAt = new Date().toISOString();
    } catch (err) {
      job.status = 'error';
      job.error = String(err.message || err);
      job.message = `Fehler: ${job.error}`;
      job.finishedAt = new Date().toISOString();
      appendJobLog(id, job.message);
    }
  });
}

export function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    message: job.message,
    error: job.error,
    result: job.result,
    meta: job.meta,
    log: job.log.slice(-40),
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}
