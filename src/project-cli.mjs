#!/usr/bin/env node
/**
 * Project / take CLI (Phase 1 runner — same logic UI will call later).
 *
 *   node src/project-cli.mjs create-project demo
 *   node src/project-cli.mjs add-take demo --insv ".../VID_…_00_011.insv"
 *   node src/project-cli.mjs stitch-proxy demo 011
 *   node src/project-cli.mjs set-proxy demo 011 --file equirect.mp4
 *   node src/project-cli.mjs import-timeline demo 011 --from equirect.mp4.timeline.json
 *   node src/project-cli.mjs final demo 011 --use-proxy-as-master
 *   node src/project-cli.mjs status demo
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  getInstaRoot,
  inboxDir,
  createProject,
  addTake,
  loadProject,
  loadTake,
  groupInboxTakes,
  takeIdFromInsv,
} from './project.mjs';
import {
  stitchTake,
  setProxyFile,
  resolveStitchBackend,
  resolveWindowsMediaSdk,
} from './stitch.mjs';
import { renderFinal, renderProjectFinals, importTimeline } from './final.mjs';

function usage() {
  console.log(`
insta360-reframe project CLI

  create-project <id> [--label "…"]
  add-take <project> --insv <file> [--insv <file2>] [--id 011]
  add-take-from-inbox <project> --take 011
  list-inbox
  stitch-proxy <project> <take> [--backend windows|docker]
  stitch-final-master <project> <take> [--backend windows|docker]
  stitch-backend                         show resolved stitch backend / SDK paths
  set-proxy <project> <take> --file <equirect.mp4>
  import-timeline <project> <take> --from <timeline.json|txt>
  final <project> <take> [--use-proxy-as-master] [--keep-master]
  export-all <project> [--concat-only]
  status <project> [take]

Root: ${getInstaRoot()}  (override INSTA360_ROOT)
`);
}

function parseArgs(argv) {
  const a = argv.slice(2);
  const cmd = a[0];
  const positional = [];
  const flags = {};
  for (let i = 1; i < a.length; i++) {
    const x = a[i];
    if (x === '--label') flags.label = a[++i];
    else if (x === '--insv') {
      if (!flags.insv) flags.insv = [];
      flags.insv.push(a[++i]);
    } else if (x === '--id' || x === '--take') flags.takeId = a[++i];
    else if (x === '--file' || x === '--from') flags.file = a[++i];
    else if (x === '--use-proxy-as-master') flags.useProxyAsMaster = true;
    else if (x === '--keep-master') flags.keepMaster = true;
    else if (x === '--concat-only') flags.concatOnly = true;
    else if (x === '--backend') flags.backend = a[++i];
    else if (x === '-h' || x === '--help') flags.help = true;
    else if (!x.startsWith('-')) positional.push(x);
  }
  return { cmd, positional, flags };
}

async function main() {
  const { cmd, positional, flags } = parseArgs(process.argv);
  if (!cmd || flags.help) {
    usage();
    return;
  }

  const log = (s) => console.log(s);

  if (cmd === 'create-project') {
    const id = positional[0];
    if (!id) throw new Error('create-project <id>');
    const p = createProject(id, { label: flags.label });
    console.log(`created project ${p.id} → ${path.join(getInstaRoot(), 'projects', p.id)}`);
    return;
  }

  if (cmd === 'list-inbox') {
    const dir = inboxDir();
    const files = fs.readdirSync(dir).filter((f) => /\.insv$/i.test(f)).map((f) => path.join(dir, f));
    const groups = groupInboxTakes(files);
    for (const g of groups) {
      console.log(`${g.id}\t${g.files.map((f) => path.basename(f)).join(' + ')}`);
    }
    return;
  }

  if (cmd === 'add-take') {
    const projectId = positional[0];
    const insv = flags.insv || [];
    if (!projectId || !insv.length) throw new Error('add-take <project> --insv file [--insv file2]');
    const takeId = flags.takeId || takeIdFromInsv(insv[0]);
    const take = addTake(projectId, takeId, insv, { label: flags.label });
    console.log(`added take ${take.id} (${take.raw.length} raw) status=${take.status}`);
    return;
  }

  if (cmd === 'add-take-from-inbox') {
    const projectId = positional[0];
    const takeId = flags.takeId || positional[1];
    if (!projectId || !takeId) throw new Error('add-take-from-inbox <project> --take 011');
    const dir = inboxDir();
    const files = fs.readdirSync(dir).filter((f) => /\.insv$/i.test(f)).map((f) => path.join(dir, f));
    const g = groupInboxTakes(files).find((x) => x.id === takeId);
    if (!g) throw new Error(`Take ${takeId} not found in inbox`);
    const take = addTake(projectId, takeId, g.files);
    console.log(`added take ${take.id}: ${g.files.map((f) => path.basename(f)).join(', ')}`);
    return;
  }

  if (cmd === 'stitch-backend') {
    const backend = resolveStitchBackend({ backend: flags.backend });
    const sdk = resolveWindowsMediaSdk();
    console.log(`backend:  ${backend}`);
    console.log(`root:     ${getInstaRoot()}`);
    console.log(`win sdk:  ${sdk.sdkRoot}`);
    console.log(`win exe:  ${sdk.exe} (${sdk.ok ? 'ok' : 'missing'})`);
    console.log(`win models: ${sdk.models}`);
    console.log(`env INSTA360_STITCH_BACKEND=${process.env.INSTA360_STITCH_BACKEND || '(auto)'}`);
    return;
  }

  if (cmd === 'stitch-proxy') {
    const [projectId, takeId] = positional;
    if (!projectId || !takeId) throw new Error('stitch-proxy <project> <take>');
    const r = await stitchTake(projectId, takeId, {
      profile: 'proxy',
      backend: flags.backend,
      onLog: log,
    });
    console.log(`proxy ready: ${r.outputHost} (backend=${r.backend})`);
    return;
  }

  if (cmd === 'stitch-final-master') {
    const [projectId, takeId] = positional;
    if (!projectId || !takeId) throw new Error('stitch-final-master <project> <take>');
    const r = await stitchTake(projectId, takeId, {
      profile: 'final',
      backend: flags.backend,
      onLog: log,
    });
    console.log(`master ready: ${r.outputHost} (backend=${r.backend})`);
    return;
  }

  if (cmd === 'set-proxy') {
    const [projectId, takeId] = positional;
    if (!projectId || !takeId || !flags.file) throw new Error('set-proxy <project> <take> --file equirect.mp4');
    const take = setProxyFile(projectId, takeId, flags.file);
    console.log(`proxy set: ${take.proxy.path}`);
    return;
  }

  if (cmd === 'import-timeline') {
    const [projectId, takeId] = positional;
    if (!projectId || !takeId || !flags.file) throw new Error('import-timeline <project> <take> --from timeline.json');
    const take = importTimeline(projectId, takeId, flags.file);
    console.log(`timeline → ${take.timeline.path}`);
    return;
  }

  if (cmd === 'final') {
    const [projectId, takeId] = positional;
    if (!projectId || !takeId) throw new Error('final <project> <take> [--use-proxy-as-master]');
    const r = await renderFinal(projectId, takeId, {
      useProxyAsMaster: !!flags.useProxyAsMaster,
      keepMaster: !!flags.keepMaster,
      onLog: log,
      onProgress: (ev) => {
        if (ev.type === 'start') log(`export ${ev.width}x${ev.height} ${ev.encoder} segs=${ev.segments}`);
        else if (ev.type === 'segment') log(`  seg ${ev.index + 1}/${ev.total} ${ev.preset}`);
        else if (ev.type === 'done') log(`done ${(ev.size / 1e6).toFixed(1)} MB`);
      },
    });
    console.log(`final: ${r.output} (${(r.size / 1e6).toFixed(1)} MB) status=${r.take.status}`);
    return;
  }

  if (cmd === 'export-all') {
    const [projectId] = positional;
    if (!projectId) throw new Error('export-all <project> [--concat-only]');
    const r = await renderProjectFinals(projectId, {
      concatOnly: !!flags.concatOnly,
      onLog: log,
      onProgress: (ev) => {
        if (ev.message) log(ev.message);
      },
    });
    console.log(`exported: ${r.exported.length}  skipped: ${r.skipped.length}`);
    if (r.session) console.log(`session: ${r.session.path} (${(r.session.size / 1e6).toFixed(1)} MB)`);
    return;
  }

  if (cmd === 'status') {
    const [projectId, takeId] = positional;
    if (!projectId) throw new Error('status <project> [take]');
    const { project } = loadProject(projectId);
    console.log(`project ${project.id} — takes: ${project.takes.join(', ') || '(none)'}`);
    const ids = takeId ? [takeId] : project.takes;
    for (const id of ids) {
      const { take, paths } = loadTake(projectId, id);
      console.log(`  ${id}: ${take.status}${take.error ? ` ERROR ${take.error}` : ''}`);
      console.log(`    proxy: ${take.proxy?.path || '—'}`);
      console.log(`    timeline: ${fs.existsSync(paths.timelineJson) ? paths.timelineJson : '—'}`);
      console.log(`    final: ${take.final?.path || '—'} ${take.final?.size ? `(${(take.final.size / 1e6).toFixed(1)} MB)` : ''}`);
    }
    return;
  }

  usage();
  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
