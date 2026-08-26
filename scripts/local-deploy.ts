#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import {
  appendFile,
  cp,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const [targetSha, reason = '内容发布'] = process.argv.slice(2);
if (!targetSha || !/^[a-f0-9]{40}$/.test(targetSha)) {
  throw new Error('缺少合法的本地部署任务标识。');
}

const root = process.cwd();
const runtime = resolve(root, process.env.STUDIO_RUNTIME_DIR || '.studio/runtime');
const deployments = resolve(runtime, 'deployments');
const releases = resolve(runtime, 'releases');
const stateFile = resolve(deployments, `${targetSha}.json`);
const logFile = resolve(deployments, `${targetSha}.log`);
const lock = resolve(runtime, 'deployment.lock');
const astroBuildCache = resolve(runtime, 'astro-build-cache');
const bunExecutable = process.env.STUDIO_BUN_PATH || 'bun';
const studioManagedPaths = [
  'src/assets/images/content',
  'src/config/site.toml',
  'src/content',
] as const;

function ensureInsideRuntime(path: string) {
  const pathFromRuntime = relative(runtime, path);
  if (pathFromRuntime.startsWith('..') || pathFromRuntime === '') {
    throw new Error('本地部署路径超出运行目录。');
  }
}

async function update(phase: 'queued' | 'building' | 'ready' | 'error') {
  await mkdir(deployments, { recursive: true });
  const next = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(
    next,
    `${JSON.stringify(
      {
        phase,
        provider: 'local',
        targetSha,
        updatedAt: new Date().toISOString(),
        ...(phase === 'error'
          ? { logUrl: `/api/studio/deployment/log?sha=${encodeURIComponent(targetSha)}` }
          : {}),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await rename(next, stateFile);
}

async function appendLog(value: string) {
  await appendFile(logFile, value, { mode: 0o600 });
}

async function run(command: string, args: string[]) {
  await appendLog(`\n$ ${command} ${args.join(' ')}\n`);
  return new Promise<void>((accept, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${resolve(root, '.venv/bin')}:${process.env.PATH || ''}`,
        ASTRO_CACHE_DIR: astroBuildCache,
        PUBLIC_KEYSTATIC_STORAGE_KIND: 'local',
        PUBLIC_STUDIO_DEPLOYMENT_MODE: 'local',
        SITE_URL: 'https://goumin.work',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => void appendLog(String(chunk)));
    child.stderr.on('data', (chunk) => void appendLog(String(chunk)));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) accept();
      else reject(new Error(`${command} ${args.join(' ')} 退出码 ${code ?? 'unknown'}`));
    });
  });
}

async function runForStatus(command: string, args: string[]) {
  await appendLog(`\n$ ${command} ${args.join(' ')}\n`);
  return new Promise<number>((accept, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => void appendLog(String(chunk)));
    child.stderr.on('data', (chunk) => void appendLog(String(chunk)));
    child.on('error', reject);
    child.on('exit', (code) => accept(code ?? 1));
  });
}

async function backupToGitHub() {
  const existingIndex = await runForStatus('git', ['diff', '--cached', '--quiet']);
  if (existingIndex !== 0) {
    throw new Error('Git 暂存区存在非后台操作的更改，为避免误提交已停止发布。');
  }

  await run('git', ['fetch', 'origin', 'main']);
  const remoteIsAncestor = await runForStatus('git', [
    'merge-base',
    '--is-ancestor',
    'origin/main',
    'HEAD',
  ]);
  if (remoteIsAncestor !== 0) {
    throw new Error('GitHub 已有较新更改，请先同步 Mac 再发布，以免覆盖远程内容。');
  }

  await run('git', ['add', '--all', '--', ...studioManagedPaths]);
  const noManagedChanges = await runForStatus('git', ['diff', '--cached', '--quiet']);
  if (noManagedChanges === 0) {
    await appendLog('\nGitHub 备份：没有需要提交的后台内容更改。\n');
    return;
  }

  // The deployment already completed the full build and artifact verification above.
  // Avoid running the repository pre-commit build a second time for the same content.
  await run('git', ['commit', '--no-verify', '-m', `content: ${reason}`]);
  await run('git', ['push', 'origin', 'HEAD:main']);
}

async function acquireLock() {
  for (let attempt = 0; attempt < 180; attempt++) {
    try {
      await mkdir(lock);
      return true;
    } catch (error) {
      if (!(typeof error === 'object' && error && 'code' in error && error.code === 'EEXIST')) {
        throw error;
      }
      await new Promise((accept) => setTimeout(accept, 1000));
    }
  }
  throw new Error('等待上一次发布超时。');
}

async function publishRelease() {
  const release = resolve(releases, targetSha);
  const site = resolve(release, 'site');
  ensureInsideRuntime(release);
  await mkdir(release, { recursive: true });
  await cp(resolve(root, 'dist/client'), site, { recursive: true, force: false });
  await writeFile(
    resolve(release, 'release.json'),
    `${JSON.stringify({ targetSha, reason, publishedAt: new Date().toISOString() }, null, 2)}\n`,
  );

  const nextLink = resolve(runtime, `current.${targetSha}.next`);
  ensureInsideRuntime(nextLink);
  await symlink(relative(runtime, site), nextLink);
  await rename(nextLink, resolve(runtime, 'current'));

  const entries = await readdir(releases, { withFileTypes: true });
  const directories = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^[a-f0-9]{40}$/.test(entry.name))
      .map(async (entry) => ({
        name: entry.name,
        modified: (await lstat(resolve(releases, entry.name))).mtimeMs,
      })),
  );
  for (const stale of directories.sort((a, b) => b.modified - a.modified).slice(5)) {
    const stalePath = resolve(releases, stale.name);
    ensureInsideRuntime(stalePath);
    await rm(stalePath, { recursive: true });
  }
}

await mkdir(runtime, { recursive: true });
await update('queued');
let ownsLock = false;
try {
  ownsLock = await acquireLock();
  await update('building');
  await appendLog(`本地发布：${reason}\n`);
  ensureInsideRuntime(astroBuildCache);
  await rm(resolve(astroBuildCache, 'data-store.json'), { force: true });
  await run(bunExecutable, ['run', 'build']);
  await run(bunExecutable, ['run', 'verify:build']);
  await backupToGitHub();
  await publishRelease();
  await update('ready');
} catch (error) {
  await appendLog(
    `\n部署失败：${error instanceof Error ? error.stack || error.message : String(error)}\n`,
  );
  await update('error');
  process.exitCode = 1;
} finally {
  if (ownsLock) {
    ensureInsideRuntime(lock);
    await rm(lock, { recursive: true, force: true });
  }
}
