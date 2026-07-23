const el = {
  projectList: document.getElementById('projectList'),
  projectDetail: document.getElementById('projectDetail'),
  projectTitle: document.getElementById('projectTitle'),
  takeList: document.getElementById('takeList'),
  inboxList: document.getElementById('inboxList'),
  rootHint: document.getElementById('rootHint'),
  status: document.getElementById('status'),
  btnNewProject: document.getElementById('btnNewProject'),
  btnBackProjects: document.getElementById('btnBackProjects'),
  btnRefreshInbox: document.getElementById('btnRefreshInbox'),
  dlgNew: document.getElementById('dlgNew'),
  formNew: document.getElementById('formNew'),
  newId: document.getElementById('newId'),
  newLabel: document.getElementById('newLabel'),
  jobBox: document.getElementById('jobBox'),
  jobBar: document.getElementById('jobBar'),
  jobMsg: document.getElementById('jobMsg'),
  jobLog: document.getElementById('jobLog'),
};

let currentProjectId = null;
let pollTimer = null;
let pollingJobId = null;

function jobStorageKey(projectId, takeId) {
  return `insta360.job.${projectId}.${takeId}`;
}

function rememberJob(projectId, takeId, jobId) {
  try {
    sessionStorage.setItem(jobStorageKey(projectId, takeId), jobId);
  } catch {
    /* ignore */
  }
}

function rememberedJob(projectId, takeId) {
  try {
    return sessionStorage.getItem(jobStorageKey(projectId, takeId));
  } catch {
    return null;
  }
}

function forgetJob(projectId, takeId) {
  try {
    sessionStorage.removeItem(jobStorageKey(projectId, takeId));
  } catch {
    /* ignore */
  }
}

function statusLabel(s) {
  const map = {
    draft: 'Roh zugewiesen',
    stitching_proxy: 'Proxy läuft…',
    proxy_ready: 'Bereit zum Schneiden',
    editing: 'In Bearbeitung',
    rendering_final: 'Final läuft…',
    done: 'Fertig',
    error: 'Fehler',
  };
  return map[s] || s || '—';
}

async function api(path, opts) {
  const r = await fetch(path, {
    cache: 'no-store',
    headers: opts?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...opts,
  });
  const doc = await r.json().catch(() => ({}));
  if (!r.ok || doc.ok === false) throw new Error(doc.error || r.statusText || String(r.status));
  return doc;
}

function stopPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  pollingJobId = null;
}

function showJob(job) {
  if (!job) return;
  el.jobBox.hidden = false;
  const pct = Math.round((job.progress || 0) * 100);
  el.jobBar.style.width = `${pct}%`;
  const take = job.meta?.takeId ? `Take ${job.meta.takeId} · ` : '';
  el.jobMsg.textContent = `${take}${job.message || job.status}${pct ? ` (${pct}%)` : ''}`;
  el.jobLog.textContent = (job.log || []).slice(-16).join('\n');
}

async function pollJob(id, onDone) {
  if (!id) return;
  if (pollingJobId === id && pollTimer) return; // already following
  stopPoll();
  pollingJobId = id;
  const tick = async () => {
    try {
      const doc = await api(`/api/jobs/${id}`);
      showJob(doc.job);
      if (doc.job.status === 'done' || doc.job.status === 'error') {
        const pid = currentProjectId;
        const tid = doc.job.meta?.takeId;
        if (pid && tid) forgetJob(pid, tid);
        stopPoll();
        onDone?.(doc.job);
      }
    } catch (err) {
      // Job lost after server restart
      stopPoll();
      if (currentProjectId) {
        for (const key of Object.keys(sessionStorage)) {
          if (key.startsWith(`insta360.job.${currentProjectId}.`) && sessionStorage.getItem(key) === id) {
            sessionStorage.removeItem(key);
          }
        }
      }
      el.status.textContent = 'Job nicht mehr aktiv (Neustart?) — Liste aktualisiert.';
      refreshProject({ skipResume: true }).catch(() => {});
    }
  };
  await tick();
  if (pollingJobId === id) {
    pollTimer = setInterval(tick, 1000);
  }
}

/** Resume progress UI after leaving the page / reopening the project. */
async function resumeActiveJobs(takes = []) {
  if (!currentProjectId) return;
  // 1) Server-side active jobs for this project
  try {
    const doc = await api(
      `/api/jobs?project=${encodeURIComponent(currentProjectId)}&active=1`,
    );
    if (doc.jobs?.length) {
      const job = doc.jobs[0];
      if (job.meta?.takeId) rememberJob(currentProjectId, job.meta.takeId, job.id);
      el.status.textContent = `Proxy läuft weiter (Take ${job.meta?.takeId || '?'})…`;
      pollJob(job.id, async (j) => {
        if (j.status === 'done') {
          el.status.textContent = 'Proxy fertig — Editor öffnen möglich';
          await refreshProject({ skipResume: true });
        } else {
          el.status.textContent = j.message || 'Proxy fehlgeschlagen';
          await refreshProject({ skipResume: true });
        }
      });
      return;
    }
  } catch {
    /* older server or no jobs */
  }

  // 2) Per-take activeJob from project API + sessionStorage
  for (const t of takes) {
    const jobId = t.activeJob?.id || rememberedJob(currentProjectId, t.id);
    if (!jobId) continue;
    if (t.activeJob) {
      showJob(t.activeJob);
      if (t.activeJob.status === 'queued' || t.activeJob.status === 'running') {
        el.status.textContent = `Proxy läuft weiter (Take ${t.id})…`;
        pollJob(jobId, async (j) => {
          if (j.status === 'done') {
            el.status.textContent = 'Proxy fertig — Editor öffnen möglich';
            await refreshProject({ skipResume: true });
          } else {
            el.status.textContent = j.message || 'Proxy fehlgeschlagen';
            await refreshProject({ skipResume: true });
          }
        });
        return;
      }
    } else {
      try {
        const doc = await api(`/api/jobs/${jobId}`);
        if (doc.job.status === 'queued' || doc.job.status === 'running') {
          rememberJob(currentProjectId, t.id, jobId);
          el.status.textContent = `Proxy läuft weiter (Take ${t.id})…`;
          pollJob(jobId, async (j) => {
            if (j.status === 'done') {
              el.status.textContent = 'Proxy fertig — Editor öffnen möglich';
              await refreshProject({ skipResume: true });
            } else {
              el.status.textContent = j.message || 'Proxy fehlgeschlagen';
              await refreshProject({ skipResume: true });
            }
          });
          return;
        }
        forgetJob(currentProjectId, t.id);
      } catch {
        forgetJob(currentProjectId, t.id);
      }
    }
  }
}

async function loadProjects() {
  const doc = await api('/api/projects');
  el.rootHint.textContent = `Datenordner: ${doc.root}`;
  el.projectList.innerHTML = '';
  if (!doc.projects.length) {
    el.projectList.innerHTML = '<p class="hint">Noch keine Projekte — lege eines an und hol Takes aus der Inbox.</p>';
    return;
  }
  for (const p of doc.projects) {
    const card = document.createElement('div');
    card.className = 'home-card';
    card.innerHTML = `
      <div>
        <div class="title">${escapeHtml(p.label || p.id)}</div>
        <div class="meta">${escapeHtml(p.id)} · ${p.takes?.length || 0} Takes</div>
      </div>
      <div class="actions">
        <button type="button" class="primary" data-open="${escapeHtml(p.id)}">Öffnen</button>
      </div>`;
    card.querySelector('[data-open]').addEventListener('click', () => openProject(p.id));
    el.projectList.appendChild(card);
  }
}

function setHomeUrl(projectId) {
  const url = new URL(window.location.href);
  if (projectId) url.searchParams.set('project', projectId);
  else url.searchParams.delete('project');
  url.searchParams.delete('take');
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

async function openProject(id) {
  currentProjectId = id;
  setHomeUrl(id);
  el.projectDetail.hidden = false;
  el.projectList.parentElement.hidden = true;
  el.btnNewProject.hidden = true;
  await refreshProject();
  await refreshInbox();
}

function showProjectList() {
  currentProjectId = null;
  setHomeUrl(null);
  el.projectDetail.hidden = true;
  el.projectList.parentElement.hidden = false;
  el.btnNewProject.hidden = false;
  el.jobBox.hidden = true;
  stopPoll();
  loadProjects().catch((e) => { el.status.textContent = e.message; });
}

async function refreshProject({ skipResume = false } = {}) {
  if (!currentProjectId) return;
  const doc = await api(`/api/projects/${encodeURIComponent(currentProjectId)}`);
  el.projectTitle.textContent = doc.project.label || doc.project.id;
  el.takeList.innerHTML = '';
  if (!doc.takes.length) {
    el.takeList.innerHTML = '<p class="hint">Noch keine Takes — rechts aus der Inbox hinzufügen.</p>';
    return;
  }
  for (const t of doc.takes) {
    const card = document.createElement('div');
    card.className = 'home-card';
    const canEdit = t.hasProxy;
    const jobLive = t.activeJob
      && (t.activeJob.status === 'queued' || t.activeJob.status === 'running');
    // Don't trust stale stitching_* status alone (server restart kills in-memory jobs)
    const busy = !!jobLive;
    const jobPct = jobLive && t.activeJob?.progress != null
      ? ` · ${Math.round(t.activeJob.progress * 100)}%`
      : '';
    card.innerHTML = `
      <div>
        <div class="title">Take ${escapeHtml(t.id)}
          <span class="badge-status ${escapeHtml(t.status || '')}">${escapeHtml(statusLabel(t.status))}${busy ? escapeHtml(jobPct) : ''}</span>
        </div>
        <div class="meta">${escapeHtml((t.raw || []).map((f) => f.split(/[/\\\\]/).pop()).join(' + ') || '—')}
          ${t.error ? ` · ${escapeHtml(t.error)}` : ''}
          ${t.activeJob?.message ? ` · ${escapeHtml(t.activeJob.message)}` : ''}
        </div>
      </div>
      <div class="actions">
        <button type="button" data-up="${escapeHtml(t.id)}" title="Nach oben">↑</button>
        <button type="button" data-down="${escapeHtml(t.id)}" title="Nach unten">↓</button>
        <button type="button" data-stitch="${escapeHtml(t.id)}" ${busy ? 'disabled' : ''}>
          Proxy erzeugen
        </button>
        <button type="button" class="primary" data-edit="${escapeHtml(t.id)}" ${canEdit ? '' : 'disabled'}>
          Im Editor öffnen
        </button>
        <button type="button" data-reset="${escapeHtml(t.id)}" title="Hängenden Job lösen / Status zurücksetzen">
          Stuck lösen
        </button>
        <button type="button" data-remove="${escapeHtml(t.id)}" title="Take aus Projekt entfernen">
          Entfernen
        </button>
      </div>`;
    card.querySelector('[data-stitch]')?.addEventListener('click', () => startStitch(t.id));
    card.querySelector('[data-edit]')?.addEventListener('click', () => openEditor(t.id));
    card.querySelector('[data-up]')?.addEventListener('click', () => moveTake(t.id, -1));
    card.querySelector('[data-down]')?.addEventListener('click', () => moveTake(t.id, 1));
    card.querySelector('[data-reset]')?.addEventListener('click', () => resetTakeJob(t.id));
    card.querySelector('[data-remove]')?.addEventListener('click', () => removeTakeFromProject(t.id));
    el.takeList.appendChild(card);
  }
  if (!skipResume) await resumeActiveJobs(doc.takes);
}

async function refreshInbox() {
  const doc = await api('/api/inbox');
  el.inboxList.innerHTML = '';
  if (!doc.takes.length) {
    el.inboxList.innerHTML = '<p class="hint">Keine .insv in der Inbox.</p>';
    return;
  }
  for (const t of doc.takes) {
    const card = document.createElement('div');
    card.className = 'home-card';
    card.innerHTML = `
      <div>
        <div class="title">Take ${escapeHtml(t.id)}</div>
        <div class="meta">${escapeHtml(t.names.join(' + '))}</div>
      </div>
      <div class="actions">
        <button type="button" data-add="${escapeHtml(t.id)}">Hinzufügen</button>
      </div>`;
    card.querySelector('[data-add]').addEventListener('click', () => addFromInbox(t.id));
    el.inboxList.appendChild(card);
  }
}

async function addFromInbox(takeId) {
  el.status.textContent = `Füge Take ${takeId} hinzu…`;
  await api(`/api/projects/${encodeURIComponent(currentProjectId)}/takes`, {
    method: 'POST',
    body: JSON.stringify({ fromInbox: true, takeId }),
  });
  el.status.textContent = `Take ${takeId} hinzugefügt`;
  await refreshProject();
}

async function moveTake(takeId, dir) {
  const doc = await api(`/api/projects/${encodeURIComponent(currentProjectId)}`);
  const list = [...(doc.project.takes || [])];
  const i = list.indexOf(takeId);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  await api(`/api/projects/${encodeURIComponent(currentProjectId)}/reorder`, {
    method: 'POST',
    body: JSON.stringify({ takes: list }),
  });
  await refreshProject();
}

async function resetTakeJob(takeId) {
  if (!confirm(`Take ${takeId}: hängenden Job/Status zurücksetzen?\n(Fertige Proxy-Datei bleibt erhalten.)`)) return;
  forgetJob(currentProjectId, takeId);
  stopPoll();
  el.jobBox.hidden = true;
  const doc = await api(
    `/api/projects/${encodeURIComponent(currentProjectId)}/takes/${encodeURIComponent(takeId)}/reset-job`,
    { method: 'POST' },
  );
  el.status.textContent = doc.take?.status === 'proxy_ready'
    ? `Take ${takeId}: Proxy wieder erkannt — Editor möglich`
    : `Take ${takeId}: Status → ${doc.take?.status || 'draft'} — Proxy erneut erzeugen möglich`;
  await refreshProject({ skipResume: true });
}

async function removeTakeFromProject(takeId) {
  const wipe = confirm(
    `Take ${takeId} aus dem Projekt entfernen?\n\nOK = nur aus Liste\nAbbrechen = nichts tun\n\n(Dateien auf Disk bleiben; zum Löschen danach Ordner manuell entfernen.)`,
  );
  if (!wipe) return;
  forgetJob(currentProjectId, takeId);
  await api(
    `/api/projects/${encodeURIComponent(currentProjectId)}/takes/${encodeURIComponent(takeId)}`,
    { method: 'DELETE', body: JSON.stringify({ deleteFiles: false }) },
  );
  el.status.textContent = `Take ${takeId} entfernt (kann aus Inbox neu hinzugefügt werden)`;
  await refreshProject({ skipResume: true });
}

async function startStitch(takeId) {
  el.status.textContent = `Starte Proxy für Take ${takeId}…`;
  const doc = await api(
    `/api/projects/${encodeURIComponent(currentProjectId)}/takes/${encodeURIComponent(takeId)}/stitch-proxy`,
    { method: 'POST' },
  );
  if (doc.job?.id) rememberJob(currentProjectId, takeId, doc.job.id);
  showJob(doc.job);
  el.status.textContent = doc.resumed
    ? `Proxy läuft bereits (Take ${takeId})…`
    : 'Proxy-Erzeugung läuft (kann lange dauern)…';
  pollJob(doc.job.id, async (job) => {
    if (job.status === 'done') {
      el.status.textContent = 'Proxy fertig — Editor öffnen möglich';
      await refreshProject({ skipResume: true });
    } else {
      el.status.textContent = job.message || 'Proxy fehlgeschlagen';
      await refreshProject({ skipResume: true });
    }
  });
}

async function openEditor(takeId) {
  el.status.textContent = 'Öffne Editor…';
  const doc = await api(
    `/api/projects/${encodeURIComponent(currentProjectId)}/takes/${encodeURIComponent(takeId)}/open`,
    { method: 'POST' },
  );
  window.location.href = doc.editUrl || `/edit?project=${currentProjectId}&take=${takeId}`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

el.btnNewProject.addEventListener('click', () => {
  el.newId.value = '';
  el.newLabel.value = '';
  el.dlgNew.showModal();
});

el.formNew.addEventListener('submit', async (e) => {
  const submitter = e.submitter;
  if (submitter?.value === 'cancel') return;
  e.preventDefault();
  const id = el.newId.value.trim();
  if (!id) return;
  try {
    await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ id, label: el.newLabel.value.trim() || id }),
    });
    el.dlgNew.close();
    el.status.textContent = `Projekt ${id} angelegt`;
    await loadProjects();
    await openProject(id);
  } catch (err) {
    el.status.textContent = err.message;
  }
});

el.btnBackProjects.addEventListener('click', showProjectList);
el.btnRefreshInbox.addEventListener('click', () => {
  refreshInbox().catch((e) => { el.status.textContent = e.message; });
});

loadProjects()
  .then(async () => {
    const q = new URLSearchParams(window.location.search);
    const projectId = q.get('project');
    if (projectId) {
      await openProject(projectId);
      el.status.textContent = `Projekt ${projectId}`;
      return;
    }
    el.status.textContent = 'Bereit';
  })
  .catch((err) => { el.status.textContent = err.message; });
