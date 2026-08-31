#!/usr/bin/env bun

import { constants, existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { acquireStudioRuntimeLease } from '../src/utils/studio-runtime-lock';
import { parseStudioBackupRecord } from '../src/utils/studio-backup-record';

function assertSeparateDestination(source: string, destination: string) {
  if (!isAbsolute(destination)) throw new Error('离机备份目录必须使用绝对路径。');
  const fromSource = relative(source, destination);
  const fromDestination = relative(destination, source);
  if (
    fromSource === '' ||
    (!fromSource.startsWith('..') && !isAbsolute(fromSource)) ||
    (!fromDestination.startsWith('..') && !isAbsolute(fromDestination))
  ) {
    throw new Error('离机备份目录不能与本地备份目录互相嵌套。');
  }
}

async function writeJsonAtomically(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function writeBackupFailureState(error: unknown, repositoryRoot = process.cwd()) {
  const runtime = resolve(repositoryRoot, process.env.STUDIO_RUNTIME_DIR || '.studio/runtime');
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  let previous: Record<string, unknown> = {};
  try {
    previous = JSON.parse(
      await readFile(resolve(runtime, 'offsite-backup-state.json'), 'utf8'),
    ) as Record<string, unknown>;
  } catch {}
  await writeJsonAtomically(resolve(runtime, 'offsite-backup-state.json'), {
    ...previous,
    error: error instanceof Error ? error.message : String(error),
    lastAttemptAt: new Date().toISOString(),
    schemaVersion: 1,
  });
}

export async function syncStudioOffsiteBackups(
  options: {
    destination?: string;
    now?: Date;
    maximumAgeMs?: number;
    maximumEntries?: number;
    repositoryRoot?: string;
    runtimeDirectory?: string;
  } = {},
) {
  const repositoryRoot = options.repositoryRoot || process.cwd();
  const runtime = resolve(
    repositoryRoot,
    options.runtimeDirectory || process.env.STUDIO_RUNTIME_DIR || '.studio/runtime',
  );
  const sources = [resolve(runtime, 'backups'), resolve(runtime, 'offsite-pending')];
  const configuredDestination =
    options.destination || process.env.STUDIO_OFFSITE_BACKUP_DIR?.trim();
  if (!configuredDestination) {
    throw new Error('未配置 STUDIO_OFFSITE_BACKUP_DIR，草稿仍只有本地备份。');
  }
  const destination = resolve(configuredDestination);
  assertSeparateDestination(runtime, destination);
  const lease = await acquireStudioRuntimeLease({
    name: 'offsite-backup',
    purpose: '同步 Studio 草稿到离机存储',
    repositoryRoot,
    timeoutMs: 5_000,
  });
  try {
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    await chmod(runtime, 0o700);
    await mkdir(destination, { recursive: true, mode: 0o700 });
    await chmod(destination, 0o700);
    let copied = 0;
    for (const source of sources.filter((directory) => existsSync(directory))) {
      const entries = (await readdir(source, { withFileTypes: true })).filter(
        (entry) => entry.isFile() && /^[a-f0-9]{40}\.json$/u.test(entry.name),
      );
      for (const entry of entries) {
        const sourcePath = resolve(source, entry.name);
        const sourceInfo = await lstat(sourcePath);
        if (!sourceInfo.isFile() || sourceInfo.size > 32 * 1024 * 1024) continue;
        const sourceBytes = await readFile(sourcePath);
        parseStudioBackupRecord(sourceBytes, entry.name);
        const target = resolve(destination, entry.name);
        let created = false;
        if (!existsSync(target)) {
          const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
          try {
            await copyFile(sourcePath, temporary, constants.COPYFILE_EXCL);
            await chmod(temporary, 0o600);
            const temporaryBytes = await readFile(temporary);
            parseStudioBackupRecord(temporaryBytes, entry.name);
            if (!sourceBytes.equals(temporaryBytes)) {
              throw new Error(`离机备份临时副本校验失败：${entry.name}`);
            }
            try {
              await link(temporary, target);
              created = true;
            } catch (error) {
              if (!(
                typeof error === 'object' &&
                error &&
                'code' in error &&
                error.code === 'EEXIST'
              )) {
                throw error;
              }
            }
          } finally {
            await rm(temporary, { force: true });
          }
        }
        const targetBytes = await readFile(target);
        parseStudioBackupRecord(targetBytes, entry.name);
        if (!sourceBytes.equals(targetBytes)) {
          throw new Error(`离机备份中存在同名但内容不同的记录：${entry.name}`);
        }
        if (created) copied++;
        // A pending copy is acknowledged only after filename, digest and exact
        // destination bytes have all been verified.
        if (source.endsWith('offsite-pending')) await rm(sourcePath, { force: true });
      }
    }

    const now = options.now || new Date();
    const offsiteEntries = (
      await Promise.all(
        (await readdir(destination, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && /^[a-f0-9]{40}\.json$/u.test(entry.name))
          .map(async (entry) => {
            try {
              const value = parseStudioBackupRecord(
                await readFile(resolve(destination, entry.name)),
                entry.name,
              );
              return {
                date: Date.parse(value.date),
                deleted: Boolean(value.deleted),
                name: entry.name,
                path: value.path,
              };
            } catch (error) {
              throw new Error(
                `离机备份校验失败（${entry.name}）：${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }),
      )
    ).sort(
      (a, b) =>
        b.date - a.date || Number(b.deleted) - Number(a.deleted) || b.name.localeCompare(a.name),
    );
    const maximumAge = options.maximumAgeMs ?? 365 * 24 * 60 * 60 * 1000;
    const maximumEntries = options.maximumEntries ?? 500;
    const latestByPath = new Set<string>();
    const protectedNames = new Set<string>();
    for (const entry of offsiteEntries) {
      if (latestByPath.has(entry.path)) continue;
      latestByPath.add(entry.path);
      protectedNames.add(entry.name);
    }
    let retainedNonLatest = 0;
    const nonLatestBudget = Math.max(0, maximumEntries - protectedNames.size);
    const expired = offsiteEntries.filter((entry) => {
      if (protectedNames.has(entry.name)) return false;
      const keep = retainedNonLatest < nonLatestBudget && now.valueOf() - entry.date <= maximumAge;
      if (keep) retainedNonLatest++;
      return !keep;
    });
    await Promise.all(
      expired.map((entry) => rm(resolve(destination, entry.name), { force: true })),
    );
    const retained = offsiteEntries.length - expired.length;
    const state = {
      copied,
      lastAttemptAt: now.toISOString(),
      lastSuccessAt: now.toISOString(),
      retained,
      schemaVersion: 1,
    };
    await writeJsonAtomically(resolve(destination, 'backup-index.json'), state);
    await writeJsonAtomically(resolve(runtime, 'offsite-backup-state.json'), state);
    return { copied, destination, retained };
  } finally {
    await lease.release();
  }
}

if (import.meta.main) {
  try {
    const result = await syncStudioOffsiteBackups();
    console.log(`离机备份完成：新增 ${result.copied} 份，保留 ${result.retained} 份。`);
  } catch (error) {
    await writeBackupFailureState(error).catch((stateError) => {
      console.error('无法记录离机备份错误：', stateError);
    });
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

export const localBackupInternals = { assertSeparateDestination, writeBackupFailureState };
