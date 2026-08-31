import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

type LockMetadata = {
  acquiredAt: string;
  heartbeatAt: string;
  hostname: string;
  pid: number;
  purpose: string;
  token: string;
  version: 1;
};

const DEFAULT_STALE_MS = 2 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30 * 1000;

function runtimeRoot(repositoryRoot = process.cwd()) {
  return resolve(repositoryRoot, process.env.STUDIO_RUNTIME_DIR || '.studio/runtime');
}

function isErrno(error: unknown, code: string) {
  return Boolean(typeof error === 'object' && error && 'code' in error && error.code === code);
}

async function atomicJson(path: string, value: unknown, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(temporary, path);
}

async function atomicJsonInExistingDirectory(path: string, value: unknown, mode = 0o600) {
  const temporary = `${path}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
      mode,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readMetadata(path: string) {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as LockMetadata;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, 'EPERM');
  }
}

export type StudioRuntimeLease = {
  release: () => Promise<void>;
  renew: () => Promise<void>;
};

/**
 * Cross-process lease used by the Astro Studio process, scheduler and deploy worker.
 * The owner metadata makes an interrupted mkdir lock recoverable without deleting a
 * lock that still belongs to a live process on this host.
 */
export async function acquireStudioRuntimeLease(options: {
  name: string;
  purpose: string;
  repositoryRoot?: string;
  staleMs?: number;
  timeoutMs?: number;
}): Promise<StudioRuntimeLease> {
  if (!/^[a-z][a-z0-9-]{1,63}$/u.test(options.name)) {
    throw new Error('运行锁名称不合法。');
  }
  const root = runtimeRoot(options.repositoryRoot);
  const locks = resolve(root, 'locks');
  const lock = resolve(locks, `${options.name}.lock`);
  const owner = resolve(lock, 'owner.json');
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  let metadata: LockMetadata = {
    acquiredAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    hostname: hostname(),
    pid: process.pid,
    purpose: options.purpose,
    token: randomBytes(16).toString('hex'),
    version: 1,
  };

  await mkdir(locks, { recursive: true, mode: 0o700 });
  while (true) {
    try {
      await mkdir(lock, { mode: 0o700 });
      await atomicJson(owner, metadata);
      let lifecycle: 'active' | 'releasing' | 'released' = 'active';
      let operationTail = Promise.resolve();
      const serialize = <T>(operation: () => Promise<T>) => {
        const result = operationTail.then(operation, operation);
        operationTail = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      };
      return {
        renew: () => {
          return serialize(async () => {
            if (lifecycle !== 'active') return;
            const current = await readMetadata(owner);
            if (current?.token !== metadata.token) {
              lifecycle = 'released';
              throw new Error(`运行锁 ${options.name} 已不再属于当前租约。`);
            }
            metadata = { ...metadata, heartbeatAt: new Date().toISOString() };
            // Never recreate the lock directory here. If it vanished or ownership
            // changed, renewal must fail instead of resurrecting an old lease.
            await atomicJsonInExistingDirectory(owner, metadata);
          });
        },
        release: () => {
          if (lifecycle === 'released') return operationTail;
          lifecycle = 'releasing';
          return serialize(async () => {
            const current = await readMetadata(owner);
            if (current?.token === metadata.token) {
              await rm(lock, { recursive: true, force: true });
            }
            lifecycle = 'released';
          });
        },
      };
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
    }

    const current = await readMetadata(owner);
    const heartbeat = current ? Date.parse(current.heartbeatAt) : Number.NaN;
    let lockAge = 0;
    if (!current) {
      try {
        lockAge = Date.now() - (await stat(lock)).mtimeMs;
      } catch {}
    }
    // mkdir and owner.json cannot be one filesystem operation. Treat a fresh
    // owner-less directory as an acquisition in progress, not a stale lock.
    const stale = current
      ? !Number.isFinite(heartbeat) || Date.now() - heartbeat > staleMs
      : lockAge > staleMs;
    const sameHostAlive = current?.hostname === hostname() && processIsAlive(current.pid);
    if (stale && !sameHostAlive) {
      const stalePath = `${lock}.stale.${Date.now()}.${process.pid}`;
      try {
        await rename(lock, stalePath);
        await rm(stalePath, { recursive: true, force: true });
        continue;
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) {
          // Another contender may have recovered it between read and rename.
        }
      }
    }

    if (Date.now() - startedAt >= timeoutMs) {
      const detail = current
        ? `pid=${current.pid}, host=${current.hostname}, purpose=${current.purpose}`
        : '无可用的持有者元数据';
      throw new Error(`等待运行锁 ${options.name} 超时（${detail}）。`);
    }
    await new Promise((accept) => setTimeout(accept, 100));
  }
}

export async function withStudioContentFileLock<T>(
  operation: () => Promise<T>,
  repositoryRoot = process.cwd(),
) {
  const lease = await acquireStudioRuntimeLease({
    name: 'content-write',
    purpose: '后台内容原子写入',
    repositoryRoot,
  });
  try {
    return await operation();
  } finally {
    await lease.release();
  }
}

export const studioRuntimeLockInternals = {
  atomicJson,
  atomicJsonInExistingDirectory,
  processIsAlive,
  runtimeRoot,
};
