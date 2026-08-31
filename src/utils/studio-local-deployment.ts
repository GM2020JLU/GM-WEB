import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { StudioDeploymentState } from './studio-deployment';
import { withStudioContentFileLock } from './studio-runtime-lock';

const JOB_PATTERN = /^[a-f0-9]{40}$/;

export type StudioLocalDeploymentRequest = {
  attempts: number;
  createdAt: string;
  id: string;
  kind: 'deployment';
  reason: string;
  version: 1;
};

export type StudioLocalDeploymentIntent = StudioLocalDeploymentRequest & {
  phase: 'prepared' | 'committed';
  updatedAt: string;
};

function runtimeRoot() {
  return resolve(process.cwd(), process.env.STUDIO_RUNTIME_DIR || '.studio/runtime');
}

function statePath(targetSha: string) {
  if (!JOB_PATTERN.test(targetSha)) throw new Error('部署任务标识不合法。');
  return resolve(runtimeRoot(), 'deployments', `${targetSha}.json`);
}

function pendingPath(targetSha: string) {
  if (!JOB_PATTERN.test(targetSha)) throw new Error('部署任务标识不合法。');
  return resolve(runtimeRoot(), 'deployment-queue', 'pending', `${targetSha}.json`);
}

function outboxPath(targetSha: string) {
  if (!JOB_PATTERN.test(targetSha)) throw new Error('部署任务标识不合法。');
  return resolve(runtimeRoot(), 'deployment-queue', 'outbox', `${targetSha}.json`);
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function writeStudioLocalDeploymentState(state: StudioDeploymentState) {
  await writeJson(statePath(state.targetSha), state);
}

function isIntent(value: unknown): value is StudioLocalDeploymentIntent {
  if (!value || typeof value !== 'object') return false;
  const intent = value as Partial<StudioLocalDeploymentIntent>;
  return (
    intent.version === 1 &&
    intent.kind === 'deployment' &&
    (intent.phase === 'prepared' || intent.phase === 'committed') &&
    typeof intent.reason === 'string' &&
    typeof intent.createdAt === 'string' &&
    typeof intent.updatedAt === 'string' &&
    typeof intent.attempts === 'number' &&
    typeof intent.id === 'string' &&
    JOB_PATTERN.test(intent.id)
  );
}

/** Caller must hold the cross-process content lock before changing content. */
export async function prepareStudioLocalDeploymentIntent(reason: string) {
  const id = randomBytes(20).toString('hex');
  const createdAt = new Date().toISOString();
  const intent: StudioLocalDeploymentIntent = {
    attempts: 0,
    createdAt,
    id,
    kind: 'deployment',
    phase: 'prepared',
    reason: reason.trim().slice(0, 160) || '内容发布',
    updatedAt: createdAt,
    version: 1,
  };
  // The outbox is authoritative and is written before content. If SIGKILL lands
  // at any later instruction, the worker conservatively replays this intent.
  await writeJson(outboxPath(id), intent);
  await writeStudioLocalDeploymentState({
    phase: 'queued',
    provider: 'local',
    targetSha: id,
    updatedAt: createdAt,
  });
  return id;
}

/** Caller must hold the same content lock used while preparing the intent. */
export async function commitStudioLocalDeploymentIntent(id: string) {
  const value = JSON.parse(await readFile(outboxPath(id), 'utf8')) as unknown;
  if (!isIntent(value) || value.id !== id) throw new Error('部署 outbox 记录已损坏。');
  await writeJson(outboxPath(id), {
    ...value,
    phase: 'committed',
    updatedAt: new Date().toISOString(),
  } satisfies StudioLocalDeploymentIntent);
}

export async function cancelStudioLocalDeploymentIntent(id: string) {
  await Promise.all([rm(outboxPath(id), { force: true }), rm(statePath(id), { force: true })]);
}

/**
 * Move durable intents into the worker queue. Prepared intents are deliberately
 * replayed too: they mean a process may have died between content fsync and the
 * final journal update, so deploying is safer than silently losing the change.
 */
export async function replayStudioLocalDeploymentOutbox() {
  return withStudioContentFileLock(async () => {
    const directory = resolve(runtimeRoot(), 'deployment-queue', 'outbox');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^[a-f0-9]{40}\.json$/u.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    const replayed: string[] = [];
    for (const entry of entries) {
      const source = resolve(directory, entry.name);
      const value = JSON.parse(await readFile(source, 'utf8')) as unknown;
      if (!isIntent(value) || `${value.id}.json` !== entry.name) {
        throw new Error(`部署 outbox 记录已损坏：${entry.name}`);
      }
      const request: StudioLocalDeploymentRequest = {
        attempts: value.attempts,
        createdAt: value.createdAt,
        id: value.id,
        kind: value.kind,
        reason: value.reason,
        version: 1,
      };
      await writeJson(pendingPath(value.id), request);
      await writeStudioLocalDeploymentState({
        phase: 'queued',
        provider: 'local',
        targetSha: value.id,
        updatedAt: new Date().toISOString(),
      });
      await rm(source, { force: true });
      replayed.push(value.id);
    }
    return replayed;
  });
}

/**
 * Enqueue only. A single launchd-supervised worker consumes and coalesces requests;
 * an API request never owns the build process and therefore cannot orphan it.
 */
export async function startStudioLocalDeployment(reason: string) {
  return withStudioContentFileLock(async () => {
    const id = await prepareStudioLocalDeploymentIntent(reason);
    await commitStudioLocalDeploymentIntent(id);
    return id;
  });
}

export async function readStudioLocalDeployment(
  targetSha?: string,
): Promise<StudioDeploymentState> {
  if (!targetSha) {
    return {
      phase: 'ready',
      provider: 'local',
      targetSha: '0'.repeat(40),
      updatedAt: new Date().toISOString(),
    };
  }
  try {
    return JSON.parse(await readFile(statePath(targetSha), 'utf8')) as StudioDeploymentState;
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') {
      throw Object.assign(new Error('找不到本地部署任务。'), { status: 404 });
    }
    throw error;
  }
}

export const localDeploymentState = {
  pendingPath,
  outboxPath,
  runtimeRoot,
  statePath,
  writeState: writeStudioLocalDeploymentState,
};
