/**
 * MediaSDK stitch — backends: windows (native) | docker
 *
 *   INSTA360_STITCH_BACKEND=windows|docker   (default: windows on win32 if SDK present, else docker)
 *   INSTA360_MEDIASDK_WIN=.../MediaSDK-root  (bin/ + models/)
 *   INSTA360_MEDIASDK_IMAGE=ai-stack/insta360-mediasdk:3.1.1
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

export function defaultWindowsSdkRoot(root = getInstaRoot()) {
  return process.env.INSTA360_MEDIASDK_WIN
    || path.join(root, 'sdk', 'windows', 'MediaSDK-root');
}

export function resolveWindowsMediaSdk(root = getInstaRoot()) {
  const sdkRoot = path.resolve(defaultWindowsSdkRoot(root));
  const exe = path.join(sdkRoot, 'bin', 'MediaSDKTest.exe');
  const models = path.join(sdkRoot, 'models');
  const ok = fs.existsSync(exe) && fs.existsSync(models);
  return { sdkRoot, exe, models, ok };
}

/**
 * @returns {'windows'|'docker'}
 */
export function resolveStitchBackend({ backend, root = getInstaRoot() } = {}) {
  const forced = (backend || process.env.INSTA360_STITCH_BACKEND || '').toLowerCase();
  if (forced === 'windows' || forced === 'win' || forced === 'native') return 'windows';
  if (forced === 'docker') return 'docker';
  // Auto: prefer native Windows SDK when present
  if (process.platform === 'win32' && resolveWindowsMediaSdk(root).ok) return 'windows';
  return 'docker';
}

function runProcess(cmd, args, { cwd, onStdout, onStderr, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
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
      else reject(new Error(`${cmd} exited ${code}\n${stderr.slice(-3000)}`));
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

/** Native Windows CLI args (host paths). cwd must be bin/ for DLL resolution. */
export function buildStitchWindowsArgs({
  inputsHost,
  outputHost,
  outputSize,
  flowstate = true,
  directionLock = true,
  modelsDir,
}) {
  const args = [
    '-inputs', inputsHost.map((p) => path.resolve(p)).join(','),
    '-output', path.resolve(outputHost),
    '-model_root_dir', path.resolve(modelsDir),
    '-output_size', outputSize,
  ];
  if (flowstate) args.push('-enable_flowstate');
  if (directionLock) args.push('-enable_directionlock');
  return args;
}

async function runStitchBackend({
  backend,
  inputsHost,
  outputHost,
  outputSize,
  flowstate,
  directionLock,
  root,
  onLog,
}) {
  fs.mkdirSync(path.dirname(outputHost), { recursive: true });

  if (backend === 'windows') {
    const sdk = resolveWindowsMediaSdk(root);
    if (!sdk.ok) {
      throw new Error(
        `Windows MediaSDK not found (expected ${sdk.exe}). Unpack under sdk/windows or set INSTA360_MEDIASDK_WIN.`,
      );
    }
    const args = buildStitchWindowsArgs({
      inputsHost,
      outputHost,
      outputSize,
      flowstate,
      directionLock,
      modelsDir: sdk.models,
    });
    onLog?.(`stitch backend=windows exe=${sdk.exe}`);
    onLog?.(`output_size=${outputSize} → ${outputHost}`);
    // cwd=bin so sibling DLLs resolve without PATH install
    await runProcess(sdk.exe, args, {
      cwd: path.dirname(sdk.exe),
      onStdout: (s) => onLog?.(s.trimEnd()),
      onStderr: (s) => onLog?.(s.trimEnd()),
    });
    return { backend: 'windows', exe: sdk.exe };
  }

  const args = buildStitchDockerArgs({
    inputsHost,
    outputHost,
    outputSize,
    flowstate,
    directionLock,
    root,
  });
  onLog?.(`stitch backend=docker ${args.join(' ').slice(0, 180)}…`);
  onLog?.(`output_size=${outputSize} → ${outputHost}`);
  await runProcess('docker', args, {
    onStdout: (s) => onLog?.(s.trimEnd()),
    onStderr: (s) => onLog?.(s.trimEnd()),
  });
  return { backend: 'docker' };
}

/**
 * @param {'proxy'|'final'} profile
 * @param {object} [opts]
 * @param {boolean} [opts.flowstate]
 * @param {boolean} [opts.directionLock]
 * @param {string} [opts.outputHost] override output path (experiment / alternate file)
 * @param {boolean} [opts.updateManifest=true] write take.json status/proxy
 * @param {string} [opts.outputSize] e.g. 1920x960
 */
export async function stitchTake(projectId, takeId, {
  profile = 'proxy',
  root = getInstaRoot(),
  backend,
  onLog,
  keepOutput = true,
  flowstate,
  directionLock,
  outputHost: outputOverride,
  outputSize: sizeOverride,
  updateManifest = true,
} = {}) {
  const { take, paths } = loadTake(projectId, takeId, root);
  if (!take.raw?.length) throw new Error('Take has no raw .insv paths');

  const isProxy = profile === 'proxy';
  const outputHost = outputOverride || (isProxy ? paths.proxyMp4 : paths.masterMp4);
  const outputSize = sizeOverride
    || (isProxy
      ? (take.stitch?.proxyOutputSize || '1920x960')
      : (take.stitch?.finalOutputSize || suggestFinalOutputSize(take.final?.width || 1920)));

  const resolvedBackend = resolveStitchBackend({ backend, root });
  const useFlowstate = flowstate != null ? !!flowstate : take.stitch?.flowstate !== false;
  const useDirectionLock = directionLock != null ? !!directionLock : take.stitch?.directionLock !== false;

  if (updateManifest) {
    take.status = isProxy ? 'stitching_proxy' : 'rendering_final';
    take.error = null;
    take.stitch = { ...take.stitch, lastBackend: resolvedBackend };
    saveTake(projectId, take, root);
  }

  if (fs.existsSync(outputHost)) fs.unlinkSync(outputHost);

  try {
    await runStitchBackend({
      backend: resolvedBackend,
      inputsHost: take.raw,
      outputHost,
      outputSize,
      flowstate: useFlowstate,
      directionLock: useDirectionLock,
      root,
      onLog,
    });
  } catch (err) {
    if (updateManifest) {
      const { take: t } = loadTake(projectId, takeId, root);
      t.status = 'error';
      t.error = String(err.message || err);
      saveTake(projectId, t, root);
    }
    throw err;
  }

  if (!fs.existsSync(outputHost)) {
    const msg = `Stitch finished but output missing: ${outputHost}`;
    if (updateManifest) {
      const { take: after } = loadTake(projectId, takeId, root);
      after.status = 'error';
      after.error = msg;
      saveTake(projectId, after, root);
    }
    throw new Error(msg);
  }

  if (updateManifest) {
    const { take: after } = loadTake(projectId, takeId, root);
    const [w, h] = String(outputSize).split('x').map(Number);
    if (isProxy) {
      after.proxy = {
        path: outputHost,
        width: w || null,
        height: h || null,
        outputSize,
        backend: resolvedBackend,
      };
      after.status = 'proxy_ready';
    } else {
      after._lastMaster = outputHost;
    }
    saveTake(projectId, after, root);
    return {
      take: after,
      outputHost,
      outputSize,
      profile,
      backend: resolvedBackend,
      flowstate: useFlowstate,
      directionLock: useDirectionLock,
    };
  }

  return {
    take,
    outputHost,
    outputSize,
    profile,
    backend: resolvedBackend,
    flowstate: useFlowstate,
    directionLock: useDirectionLock,
  };
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
