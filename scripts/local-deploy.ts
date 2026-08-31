#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  appendFile,
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import {
  localDeploymentState,
  replayStudioLocalDeploymentOutbox,
  type StudioLocalDeploymentRequest,
  writeStudioLocalDeploymentState,
} from '../src/utils/studio-local-deployment';
import {
  acquireStudioRuntimeLease,
  withStudioContentFileLock,
} from '../src/utils/studio-runtime-lock';

const root = process.cwd();
const runtime = localDeploymentState.runtimeRoot();
const deployments = resolve(runtime, 'deployments');
const queue = resolve(runtime, 'deployment-queue');
const pending = resolve(queue, 'pending');
const processing = resolve(queue, 'processing');
const releases = resolve(runtime, 'releases');
const worktrees = resolve(runtime, 'worktrees');
const astroBuildCache = resolve(runtime, 'astro-build-cache');
const once = process.argv.includes('--once');
const pollIntervalMs = Number(process.env.STUDIO_WORKER_POLL_MS || 2_000);
const buildTimeoutMs = Number(process.env.STUDIO_BUILD_TIMEOUT_MS || 15 * 60 * 1000);
const productionTimeoutMs = Number(process.env.STUDIO_PRODUCTION_TIMEOUT_MS || 12 * 60 * 1000);
const configuredBun = process.env.STUDIO_BUN_PATH?.trim();
const bunExecutable =
  configuredBun ||
  [
    process.env.HOME ? resolve(process.env.HOME, '.bun/bin/bun') : '',
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
  ].find((candidate) => candidate && existsSync(candidate)) ||
  'bun';
const studioManagedPaths = [
  'src/assets/images/content',
  'src/config/site.toml',
  'src/content',
] as const;

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

function ensureInsideRuntime(path: string) {
  const pathFromRuntime = relative(runtime, path);
  if (pathFromRuntime.startsWith('..')) {
    throw new Error('本地部署路径超出运行目录。');
  }
}

function isRequest(value: unknown): value is StudioLocalDeploymentRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<StudioLocalDeploymentRequest>;
  return (
    request.version === 1 &&
    request.kind === 'deployment' &&
    typeof request.reason === 'string' &&
    typeof request.createdAt === 'string' &&
    typeof request.attempts === 'number' &&
    typeof request.id === 'string' &&
    /^[a-f0-9]{40}$/u.test(request.id)
  );
}

async function prepareDirectories() {
  for (const directory of [runtime, deployments, queue, pending, processing, releases, worktrees]) {
    ensureInsideRuntime(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
}

function logFile(request: StudioLocalDeploymentRequest) {
  return resolve(deployments, `${request.id}.log`);
}

async function appendLogs(requests: StudioLocalDeploymentRequest[], value: string) {
  await Promise.all(
    requests.map((request) => appendFile(logFile(request), value, { mode: 0o600 })),
  );
}

async function updateRequests(
  requests: StudioLocalDeploymentRequest[],
  phase: 'queued' | 'building' | 'ready' | 'error',
  extra: Record<string, unknown> = {},
) {
  await Promise.all(
    requests.map((request) =>
      writeStudioLocalDeploymentState({
        phase,
        provider: 'local',
        targetSha: request.id,
        updatedAt: new Date().toISOString(),
        ...(phase === 'error'
          ? { logUrl: `/api/studio/deployment/log?sha=${encodeURIComponent(request.id)}` }
          : {}),
        ...extra,
      }),
    ),
  );
}

async function run(
  requests: StudioLocalDeploymentRequest[],
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    tolerateFailure?: boolean;
  } = {},
) {
  await appendLogs(requests, `\n$ ${command} ${args.join(' ')}\n`);
  return new Promise<{ code: number; output: string }>((accept, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || root,
      detached: true,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let logTail = Promise.resolve();
    const capture = (chunk: Buffer | string) => {
      const text = String(chunk);
      output += text;
      if (output.length > 256 * 1024) output = output.slice(-256 * 1024);
      logTail = logTail.then(() => appendLogs(requests, text));
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const timeoutMs = options.timeoutMs ?? 2 * 60 * 1000;
    const timeout = setTimeout(() => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
      setTimeout(() => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }, 5_000).unref();
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      void logTail.then(() => {
        const exitCode = code ?? 1;
        if (exitCode === 0 || options.tolerateFailure) {
          accept({ code: exitCode, output });
        } else {
          reject(
            new Error(
              `${command} ${args.join(' ')} ${signal ? `被 ${signal} 终止` : `退出码 ${exitCode}`}`,
            ),
          );
        }
      });
    });
  });
}

async function gitOutput(
  requests: StudioLocalDeploymentRequest[],
  args: string[],
  options: Parameters<typeof run>[3] = {},
) {
  const result = await run(requests, 'git', args, options);
  return result.output.trim();
}

async function recoverInterruptedRequests() {
  const entries = await readdir(processing, { withFileTypes: true });
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith('.json'))) {
    const source = resolve(processing, entry.name);
    const target = resolve(pending, entry.name);
    try {
      const request = JSON.parse(await readFile(source, 'utf8')) as unknown;
      if (!isRequest(request)) throw new Error('部署请求已损坏。');
      if (existsSync(target)) await rm(source, { force: true });
      else await rename(source, target);
      await updateRequests([request], 'queued');
      await appendLogs([request], '\nWorker 重启：已恢复中断的部署请求。\n');
    } catch (error) {
      await rm(source, { force: true });
      const id = entry.name.replace(/\.json$/u, '');
      if (/^[a-f0-9]{40}$/u.test(id)) {
        const damaged: StudioLocalDeploymentRequest = {
          attempts: 0,
          createdAt: new Date().toISOString(),
          id,
          kind: 'deployment',
          reason: '损坏的恢复请求',
          version: 1,
        };
        await appendLogs([damaged], `部署请求已损坏：${String(error)}\n`);
        await updateRequests([damaged], 'error');
      }
      console.error(`无法恢复 ${entry.name}:`, error);
    }
  }
}

async function claimPendingBatch() {
  const entries = (await readdir(pending, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^[a-f0-9]{40}\.json$/u.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const requests: StudioLocalDeploymentRequest[] = [];
  for (const entry of entries) {
    const source = resolve(pending, entry.name);
    const target = resolve(processing, entry.name);
    try {
      await rename(source, target);
      const request = JSON.parse(await readFile(target, 'utf8')) as unknown;
      if (!isRequest(request)) throw new Error('部署请求格式不合法。');
      requests.push(request);
    } catch (error) {
      await rm(target, { force: true });
      const id = entry.name.replace(/\.json$/u, '');
      if (/^[a-f0-9]{40}$/u.test(id)) {
        const damaged: StudioLocalDeploymentRequest = {
          attempts: 0,
          createdAt: new Date().toISOString(),
          id,
          kind: 'deployment',
          reason: '损坏的排队请求',
          version: 1,
        };
        await appendLogs([damaged], `部署请求已损坏：${String(error)}\n`);
        await updateRequests([damaged], 'error');
      }
      console.error(`忽略损坏的部署请求 ${entry.name}:`, error);
    }
  }
  return requests;
}

async function createImmutableSnapshot(requests: StudioLocalDeploymentRequest[]) {
  await run(requests, 'git', ['fetch', '--quiet', 'origin', 'main']);
  const ancestry = await run(
    requests,
    'git',
    ['merge-base', '--is-ancestor', 'origin/main', 'HEAD'],
    { tolerateFailure: true },
  );
  if (ancestry.code !== 0) {
    throw new Error('GitHub main 已领先 Mac，需先安全同步仓库再发布。');
  }

  return withStudioContentFileLock(async () => {
    const staged = await run(requests, 'git', ['diff', '--cached', '--quiet'], {
      tolerateFailure: true,
    });
    if (staged.code !== 0) {
      throw new Error('Git 暂存区存在非后台操作，为避免误提交已停止发布。');
    }
    await run(requests, 'git', ['add', '--all', '--', ...studioManagedPaths]);
    const noChanges = await run(requests, 'git', ['diff', '--cached', '--quiet'], {
      tolerateFailure: true,
    });
    if (noChanges.code !== 0) {
      const reasons = [...new Set(requests.map((request) => request.reason))].join('；');
      await run(requests, 'git', [
        '-c',
        'user.name=GM Studio',
        '-c',
        'user.email=studio@users.noreply.github.com',
        'commit',
        '--no-verify',
        '-m',
        `content: ${reasons.slice(0, 180)}`,
      ]);
    }
    const snapshotSha = await gitOutput(requests, ['rev-parse', 'HEAD']);
    if (!/^[a-f0-9]{40}$/u.test(snapshotSha)) throw new Error('无法生成不可变发布快照。');
    return snapshotSha;
  });
}

async function prepareWorktree(requests: StudioLocalDeploymentRequest[], snapshotSha: string) {
  const worktree = resolve(worktrees, snapshotSha);
  ensureInsideRuntime(worktree);
  await run(requests, 'git', ['worktree', 'prune']);
  await rm(worktree, { recursive: true, force: true });
  await run(requests, 'git', ['worktree', 'add', '--detach', worktree, snapshotSha]);
  for (const dependency of ['node_modules', '.venv']) {
    const source = resolve(root, dependency);
    const target = resolve(worktree, dependency);
    if (existsSync(source) && !existsSync(target)) await symlink(source, target, 'dir');
  }
  return worktree;
}

async function publishRelease(
  requests: StudioLocalDeploymentRequest[],
  worktree: string,
  snapshotSha: string,
) {
  const release = resolve(releases, snapshotSha);
  const site = resolve(release, 'site');
  const staging = resolve(releases, `.${snapshotSha}.staging`);
  const previous = resolve(releases, `.${snapshotSha}.previous`);
  ensureInsideRuntime(release);
  ensureInsideRuntime(staging);
  ensureInsideRuntime(previous);
  if (!existsSync(release) && existsSync(previous)) await rename(previous, release);
  let validExisting = false;
  try {
    const marker = JSON.parse(
      await readFile(resolve(site, '.well-known/navfolio-build.json'), 'utf8'),
    ) as { sha?: unknown };
    validExisting = marker.sha === snapshotSha && existsSync(resolve(site, 'index.html'));
  } catch {}
  if (!validExisting) {
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true, mode: 0o700 });
    await cp(resolve(worktree, 'dist/client'), resolve(staging, 'site'), {
      recursive: true,
      force: false,
    });
    await writeFile(
      resolve(staging, 'release.json'),
      `${JSON.stringify(
        {
          jobs: requests.map((request) => request.id),
          publishedAt: new Date().toISOString(),
          snapshotSha,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await rm(previous, { recursive: true, force: true });
    if (existsSync(release)) await rename(release, previous);
    await rename(staging, release);
    await rm(previous, { recursive: true, force: true });
  } else {
    await writeFile(
      resolve(release, 'release.json'),
      `${JSON.stringify(
        {
          jobs: requests.map((request) => request.id),
          publishedAt: new Date().toISOString(),
          snapshotSha,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }

  const nextLink = resolve(runtime, `current.${snapshotSha}.next`);
  ensureInsideRuntime(nextLink);
  await rm(nextLink, { force: true });
  await symlink(relative(runtime, site), nextLink);
  await rename(nextLink, resolve(runtime, 'current'));

  const entries = await readdir(releases, { withFileTypes: true });
  const directories = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^[a-f0-9]{40}$/u.test(entry.name))
      .map(async (entry) => ({
        name: entry.name,
        modified: (await lstat(resolve(releases, entry.name))).mtimeMs,
      })),
  );
  for (const stale of directories.sort((a, b) => b.modified - a.modified).slice(5)) {
    const stalePath = resolve(releases, stale.name);
    ensureInsideRuntime(stalePath);
    await rm(stalePath, { recursive: true, force: true });
  }
}

async function readProductionMarker(productionUrl: URL) {
  const marker = new URL('/.well-known/navfolio-build.json', productionUrl);
  marker.searchParams.set('_studio_check', Date.now().toString());
  const response = await fetch(marker, {
    cache: 'no-store',
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return undefined;
  const length = Number(response.headers.get('content-length') || 0);
  if (length > 8_192) throw new Error('生产构建标记超出大小限制。');
  const text = await response.text();
  if (text.length > 8_192) throw new Error('生产构建标记超出大小限制。');
  const value = JSON.parse(text) as { sha?: unknown };
  return typeof value.sha === 'string' && /^[a-f0-9]{40}$/u.test(value.sha) ? value.sha : undefined;
}

async function waitForProduction(requests: StudioLocalDeploymentRequest[], snapshotSha: string) {
  const productionUrl = new URL(process.env.STUDIO_PRODUCTION_URL || 'https://goumin.work');
  if (productionUrl.protocol !== 'https:') {
    throw new Error('生产站点检查必须使用 HTTPS。');
  }
  const deadline = Date.now() + productionTimeoutMs;
  let lastObserved: string | undefined;
  while (Date.now() < deadline && !stopping) {
    try {
      lastObserved = await readProductionMarker(productionUrl);
      if (lastObserved === snapshotSha) {
        await appendLogs(requests, `\n生产域名已运行提交 ${snapshotSha}。\n`);
        return productionUrl.origin;
      }
    } catch (error) {
      await appendLogs(
        requests,
        `\n等待生产标记：${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    await new Promise((accept) => setTimeout(accept, 5_000));
  }
  throw new Error(
    `生产域名未在限时内切换到 ${snapshotSha}（当前观察到 ${lastObserved || '无标记'}）。`,
  );
}

async function processBatch(requests: StudioLocalDeploymentRequest[]) {
  await updateRequests(requests, 'building');
  await appendLogs(requests, `本地发布队列：合并 ${requests.length} 个请求。\n`);
  let worktree: string | undefined;
  let snapshotSha: string | undefined;
  let previewReady = false;
  try {
    snapshotSha = await createImmutableSnapshot(requests);
    await updateRequests(requests, 'building', { snapshotSha });
    worktree = await prepareWorktree(requests, snapshotSha);
    const buildEnvironment = {
      ...process.env,
      ASTRO_CACHE_DIR: astroBuildCache,
      NAVFOLIO_BUILD_SHA: snapshotSha,
      PATH: `${resolve(root, '.venv/bin')}:${process.env.PATH || ''}`,
      PUBLIC_KEYSTATIC_STORAGE_KIND: 'local',
      PUBLIC_STUDIO_DEPLOYMENT_MODE: 'local',
      SITE_URL: 'https://goumin.work',
    };
    await rm(resolve(astroBuildCache, 'data-store.json'), { force: true });
    await run(requests, bunExecutable, ['run', 'build'], {
      cwd: worktree,
      env: buildEnvironment,
      timeoutMs: buildTimeoutMs,
    });
    await run(requests, bunExecutable, ['run', 'verify:build'], {
      cwd: worktree,
      env: buildEnvironment,
      timeoutMs: 3 * 60 * 1000,
    });
    await run(requests, 'git', ['push', 'origin', `${snapshotSha}:refs/heads/main`], {
      timeoutMs: 2 * 60 * 1000,
    });
    await publishRelease(requests, worktree, snapshotSha);
    previewReady = true;
    await updateRequests(requests, 'building', {
      previewReady: true,
      snapshotSha,
    });
    const productionUrl = await waitForProduction(requests, snapshotSha);
    await updateRequests(requests, 'ready', {
      previewReady: true,
      productionUrl,
      runtimeSha: snapshotSha,
      snapshotSha,
    });
  } catch (error) {
    await appendLogs(
      requests,
      `\n部署失败：${error instanceof Error ? error.stack || error.message : String(error)}\n`,
    );
    await updateRequests(requests, 'error', {
      ...(snapshotSha ? { snapshotSha } : {}),
      ...(previewReady ? { previewReady } : {}),
    });
  } finally {
    if (worktree) {
      await run(requests, 'git', ['worktree', 'remove', '--force', worktree], {
        tolerateFailure: true,
      });
      ensureInsideRuntime(worktree);
      await rm(worktree, { recursive: true, force: true });
    }
    await Promise.all(
      requests.map((request) => rm(resolve(processing, `${request.id}.json`), { force: true })),
    );
  }
}

await prepareDirectories();
const workerLease = await acquireStudioRuntimeLease({
  name: 'deployment-worker',
  purpose: '单例本地部署 worker',
  staleMs: 90_000,
  timeoutMs: 1_000,
});
const heartbeat = setInterval(() => {
  void workerLease.renew().catch((error) => {
    console.error('Worker 租约续期失败：', error);
    stopping = true;
  });
}, 15_000);
heartbeat.unref();

try {
  await recoverInterruptedRequests();
  do {
    await replayStudioLocalDeploymentOutbox();
    const requests = await claimPendingBatch();
    if (requests.length) await processBatch(requests);
    if (once) break;
    if (!stopping && !requests.length) {
      await new Promise((accept) => setTimeout(accept, pollIntervalMs));
    }
  } while (!stopping);
} finally {
  clearInterval(heartbeat);
  await workerLease.release();
}
