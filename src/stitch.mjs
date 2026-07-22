/**
 * MediaSDK stitch via Docker (proxy | final profiles).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  getInstaRoot,
  toContainerPath,
  defaultTakePaths,
  loadTake,
  saveTake,
  suggestFinalOutputSize,
} from './project.mjs';

const DEFAULT_IMAGE = process.env.INSTA360_MEDIASDK_IMAGE || 'ai-stack/insta360-mediasdk:3.1.1';

function runDocker(args, { onStdout, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (onStdout) onStdout(s);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (onStderr) onStderr(s);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`docker exited ${code}\n${stderr.slice(-3000)}`));
    });
  });
}

export function buildStitchDockerArgs({
  inputsHost,
  outputHost,
  outputSize,
  flowstate = true,
  directionLock = true,
  image = DEFAULT_IMAGE,
  root = getInstaRoot(),
}) {
  const inbox = path.join(root, 'inbox');
  const work = path.join(root, 'work');
  const out = path.join(root, 'out');
  const projects = path.join(root, 'projects');
  for (const d of [projects, path.dirname(outputHost)]) {
    fs.mkdirSync(d, { recursive: true });
  }

  const inputs = inputsHost.map((h) => toContainerPath(h, root)).join(',');
  const output = toContainerPath(outputHost, root);

  const args = [
    'run', '--rm',
    '--gpus', 'all',
    '-e', 'NVIDIA_VISIBLE_DEVICES=all',
    '-e', 'NVIDIA_DRIVER_CAPABILITIES=compute,utility,video,graphics,display',
    '-v', `${inbox}:/data/inbox:ro`,
    '-v', `${work}:/data/work:rw`,
    '-v', `${out}:/data/out:rw`,
    '-v', `${projects}:/data/projects:rw`,
    image,
    '-inputs', inputs,
    '-output', output,
    '-model_root_dir', '/opt/insta360/models',
    '-output_size', outputSize,
  ];
  if (flowstate) args.push('-enable_flowstate');
  if (directionLock) args.push('-enable_directionlock');
  return args;
}

/**
 * @param {'proxy'|'final'} profile
 */
export async function stitchTake(projectId, takeId, {
  profile = 'proxy',
  root = getInstaRoot(),
  onLog,
  keepOutput = true,
} = {}) {
  const { take, paths } = loadTake(projectId, takeId, root);
  if (!take.raw?.length) throw new Error('Take has no raw .insv paths');

  const isProxy = profile === 'proxy';
  const outputHost = isProxy ? paths.proxyMp4 : paths.masterMp4;
  const outputSize = isProxy
    ? (take.stitch?.proxyOutputSize || '1920x960')
    : (take.stitch?.finalOutputSize || suggestFinalOutputSize(take.final?.width || 1920));

  take.status = isProxy ? 'stitching_proxy' : 'rendering_final';
  take.error = null;
  saveTake(projectId, take, root);

  fs.mkdirSync(path.dirname(outputHost), { recursive: true });
  if (fs.existsSync(outputHost)) fs.unlinkSync(outputHost);

  const args = buildStitchDockerArgs({
    inputsHost: take.raw,
    outputHost,
    outputSize,
    flowstate: take.stitch?.flowstate !== false,
    directionLock: take.stitch?.directionLock !== false,
    root,
  });

  onLog?.(`stitch ${profile}: docker ${args.join(' ').slice(0, 200)}…`);
  onLog?.(`output_size=${outputSize} → ${outputHost}`);

  try {
    await runDocker(args, {
      onStdout: (s) => onLog?.(s.trimEnd()),
      onStderr: (s) => onLog?.(s.trimEnd()),
    });
  } catch (err) {
    take.status = 'error';
    take.error = String(err.message || err);
    saveTake(projectId, take, root);
    throw err;
  }

  if (!fs.existsSync(outputHost)) {
    take.status = 'error';
    take.error = `Stitch finished but output missing: ${outputHost}`;
    saveTake(projectId, take, root);
    throw new Error(take.error);
  }

  const [w, h] = String(outputSize).split('x').map(Number);
  if (isProxy) {
    take.proxy = { path: outputHost, width: w || null, height: h || null, outputSize };
    take.status = 'proxy_ready';
  } else if (!keepOutput) {
    // caller may delete; still record last master path used
    take._lastMaster = outputHost;
  } else {
    take._lastMaster = outputHost;
  }
  saveTake(projectId, take, root);
  return { take, outputHost, outputSize, profile };
}

/** Attach an existing equirect as proxy (dev / skip long stitch). */
export function setProxyFile(projectId, takeId, filePath, { root = getInstaRoot() } = {}) {
  const { take, paths } = loadTake(projectId, takeId, root);
  const src = path.resolve(filePath);
  if (!fs.existsSync(src)) throw new Error(`Proxy source not found: ${src}`);
  fs.mkdirSync(paths.proxyDir, { recursive: true });
  fs.copyFileSync(src, paths.proxyMp4);
  take.proxy = { path: paths.proxyMp4, width: null, height: null, linkedFrom: src };
  take.status = 'proxy_ready';
  take.error = null;
  saveTake(projectId, take, root);
  return take;
}
