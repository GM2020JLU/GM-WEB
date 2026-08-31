#!/usr/bin/env bun

import { link, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  parseStudioBackupRecord,
  type StudioBackupRecord,
} from '../src/utils/studio-backup-record';

function safeManagedPath(path: string) {
  const normalized = path.replaceAll('\\', '/');
  return (
    !isAbsolute(normalized) &&
    !normalized.split('/').includes('..') &&
    (normalized === 'src/config/site.toml' ||
      normalized.startsWith('src/assets/images/content/') ||
      normalized.startsWith('src/content/'))
  );
}

function isNested(parent: string, child: string) {
  const path = relative(parent, child);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

export async function restoreStudioOffsiteBackup(source: string, output: string) {
  const sourceRoot = resolve(source);
  const outputRoot = resolve(output);
  if (
    sourceRoot === outputRoot ||
    isNested(sourceRoot, outputRoot) ||
    isNested(outputRoot, sourceRoot)
  ) {
    throw new Error('恢复输出目录不能位于备份目录内。');
  }
  try {
    const info = await lstat(outputRoot);
    if (!info.isDirectory() || (await readdir(outputRoot)).length > 0) {
      throw new Error('恢复输出目录必须不存在或为空。');
    }
  } catch (error) {
    if (!(typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  }
  const latest = new Map<string, StudioBackupRecord>();
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9]{40}\.json$/u.test(entry.name)) continue;
    const snapshot = parseStudioBackupRecord(
      await readFile(resolve(sourceRoot, entry.name)),
      entry.name,
    );
    if (!safeManagedPath(snapshot.path)) {
      throw new Error(`备份记录包含不安全的恢复路径：${snapshot.path}`);
    }
    const previous = latest.get(snapshot.path);
    if (
      !previous ||
      snapshot.date > previous.date ||
      (snapshot.date === previous.date &&
        (Number(Boolean(snapshot.deleted)) > Number(Boolean(previous.deleted)) ||
          (Boolean(snapshot.deleted) === Boolean(previous.deleted) && snapshot.sha > previous.sha)))
    ) {
      latest.set(snapshot.path, snapshot);
    }
  }
  let restored = 0;
  let tombstones = 0;
  for (const snapshot of latest.values()) {
    if (snapshot.deleted) {
      tombstones++;
      continue;
    }
    const target = resolve(outputRoot, snapshot.path);
    if (relative(outputRoot, target).startsWith('..')) continue;
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    const content =
      snapshot.encoding === 'base64' ? Buffer.from(snapshot.content, 'base64') : snapshot.content;
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
      await link(temporary, target);
      restored++;
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return { restored, tombstones };
}

if (import.meta.main) {
  const [source, output] = process.argv.slice(2);
  if (!source || !output) {
    throw new Error('用法：bun scripts/local-backup-restore.ts <iCloud 备份目录> <空的恢复目录>');
  }
  const result = await restoreStudioOffsiteBackup(source, output);
  console.log(`恢复 ${result.restored} 个文件，跳过 ${result.tombstones} 个删除标记。`);
}
