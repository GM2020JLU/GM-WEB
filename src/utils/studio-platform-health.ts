import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readProductionBuildSha } from './studio-deployment';

export type StudioPlatformHealthStatus = 'healthy' | 'warning' | 'error' | 'unknown';

export type StudioPlatformHealthItem = {
  checkedAt?: string;
  detail?: string;
  status: StudioPlatformHealthStatus;
  url?: string;
};

export type StudioPlatformHealth = Record<
  'production' | 'worker' | 'scheduler' | 'backup',
  StudioPlatformHealthItem
>;

function runtimeRoot(repositoryRoot = process.cwd()) {
  return resolve(repositoryRoot, process.env.STUDIO_RUNTIME_DIR || '.studio/runtime');
}

async function readJson(path: string) {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function countJsonFiles(path: string) {
  try {
    return (await readdir(path, { withFileTypes: true })).filter(
      (entry) => entry.isFile() && entry.name.endsWith('.json'),
    ).length;
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') return 0;
    throw error;
  }
}

function validDate(value: unknown) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return undefined;
  return value;
}

export async function readStudioPlatformHealth(
  options: {
    now?: Date;
    expectedProductionSha?: string;
    productionOrigin?: string;
    readProductionSha?: (origin?: string) => Promise<string | undefined>;
    repositoryRoot?: string;
  } = {},
): Promise<StudioPlatformHealth> {
  const now = options.now || new Date();
  const nowValue = now.valueOf();
  const runtime = runtimeRoot(options.repositoryRoot);
  const productionOrigin =
    options.productionOrigin || process.env.STUDIO_PRODUCTION_URL || 'https://goumin.work';

  let expectedProductionSha = options.expectedProductionSha;
  if (!expectedProductionSha) {
    try {
      const localMarker = await readJson(
        resolve(runtime, 'current/.well-known/navfolio-build.json'),
      );
      if (typeof localMarker?.sha === 'string' && /^[a-f0-9]{40}$/u.test(localMarker.sha)) {
        expectedProductionSha = localMarker.sha;
      }
    } catch {
      // A malformed local marker is represented as an unknown expected version;
      // production stays warning rather than receiving a false healthy signal.
    }
  }

  let production: StudioPlatformHealthItem;
  try {
    const sha = await (options.readProductionSha || readProductionBuildSha)(productionOrigin);
    production = sha
      ? expectedProductionSha === sha
        ? {
            checkedAt: now.toISOString(),
            detail: `生产域名已与本地期望版本 ${sha.slice(0, 7)} 一致`,
            status: 'healthy',
            url: productionOrigin,
          }
        : {
            checkedAt: now.toISOString(),
            detail: expectedProductionSha
              ? `生产域名仍为 ${sha.slice(0, 7)}，期望 ${expectedProductionSha.slice(0, 7)}`
              : `生产标记 ${sha.slice(0, 7)} 可达，但未找到本地期望版本用于一致性比较`,
            status: 'warning',
            url: productionOrigin,
          }
      : {
          checkedAt: now.toISOString(),
          detail: '生产域名未返回有效构建 SHA',
          status: 'warning',
          url: productionOrigin,
        };
  } catch (error) {
    production = {
      checkedAt: now.toISOString(),
      detail: `生产域名检查失败：${error instanceof Error ? error.message : String(error)}`,
      status: 'error',
      url: productionOrigin,
    };
  }

  let worker: StudioPlatformHealthItem;
  try {
    const [owner, outbox, pending, processing] = await Promise.all([
      readJson(resolve(runtime, 'locks/deployment-worker.lock/owner.json')),
      countJsonFiles(resolve(runtime, 'deployment-queue/outbox')),
      countJsonFiles(resolve(runtime, 'deployment-queue/pending')),
      countJsonFiles(resolve(runtime, 'deployment-queue/processing')),
    ]);
    const heartbeatAt = validDate(owner?.heartbeatAt);
    const age = heartbeatAt ? nowValue - Date.parse(heartbeatAt) : Number.POSITIVE_INFINITY;
    worker = {
      ...(heartbeatAt ? { checkedAt: heartbeatAt } : {}),
      detail: owner
        ? `Worker 心跳；outbox ${outbox}、等待 ${pending}、处理中 ${processing}`
        : `Worker 未运行；outbox ${outbox}、等待 ${pending}、处理中 ${processing}`,
      status: !owner ? 'unknown' : age <= 45_000 ? 'healthy' : 'error',
    };
  } catch (error) {
    worker = {
      checkedAt: now.toISOString(),
      detail: `Worker 状态读取失败：${error instanceof Error ? error.message : String(error)}`,
      status: 'error',
    };
  }

  let scheduler: StudioPlatformHealthItem;
  try {
    const state = await readJson(resolve(runtime, 'scheduler-state.json'));
    const checkedAt = validDate(state?.lastFinishedAt) || validDate(state?.lastStartedAt);
    const age = checkedAt ? nowValue - Date.parse(checkedAt) : Number.POSITIVE_INFINITY;
    scheduler = !state
      ? { detail: '定时发布尚无运行记录', status: 'unknown' }
      : {
          ...(checkedAt ? { checkedAt } : {}),
          detail:
            state.phase === 'error'
              ? `定时发布失败：${String(state.error || '未知错误')}`
              : age > 20 * 60 * 1000
                ? '定时发布超过 20 分钟未运行'
                : `定时发布 ${state.phase === 'running' ? '正在运行' : '运行正常'}`,
          status: state.phase === 'error' ? 'error' : age > 20 * 60 * 1000 ? 'warning' : 'healthy',
        };
  } catch (error) {
    scheduler = {
      checkedAt: now.toISOString(),
      detail: `定时发布状态读取失败：${error instanceof Error ? error.message : String(error)}`,
      status: 'error',
    };
  }

  let backup: StudioPlatformHealthItem;
  try {
    const state = await readJson(resolve(runtime, 'offsite-backup-state.json'));
    const successAt = validDate(state?.lastSuccessAt);
    const attemptAt = validDate(state?.lastAttemptAt);
    const checkedAt = attemptAt || successAt;
    const age = successAt ? nowValue - Date.parse(successAt) : Number.POSITIVE_INFINITY;
    backup = !state
      ? { detail: '离机备份尚无成功记录', status: 'unknown' }
      : {
          ...(checkedAt ? { checkedAt } : {}),
          detail: state.error
            ? `离机备份失败：${String(state.error)}`
            : age > 30 * 60 * 1000
              ? '离机备份超过 30 分钟未成功'
              : `离机备份正常，保留 ${Number(state.retained || 0)} 份`,
          status: state.error ? 'error' : age > 30 * 60 * 1000 ? 'warning' : 'healthy',
        };
  } catch (error) {
    backup = {
      checkedAt: now.toISOString(),
      detail: `离机备份状态读取失败：${error instanceof Error ? error.message : String(error)}`,
      status: 'error',
    };
  }

  return { backup, production, scheduler, worker };
}

export const studioPlatformHealthInternals = { runtimeRoot };
