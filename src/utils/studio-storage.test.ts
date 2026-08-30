import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deleteStudioFile,
  listStudioAssets,
  listStudioHistory,
  readStudioFile,
  readStudioFileAtRef,
  studioFileExists,
  StudioConflictError,
  writeStudioBinaryFile,
  writeStudioFile,
} from './studio-storage';

describe('Studio 本地备份', () => {
  test('覆盖和删除前创建可恢复的历史版本', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goumin-studio-storage-'));
    const runtime = join(root, 'runtime');
    const path = join(root, 'entry.md');
    const previousRuntime = process.env.STUDIO_RUNTIME_DIR;
    process.env.STUDIO_RUNTIME_DIR = runtime;
    try {
      await writeFile(path, '旧版本正文\n', 'utf8');
      const loaded = await readStudioFile(path);
      expect(loaded.sha).toMatch(/^[a-f0-9]{64}$/);
      const written = await writeStudioFile({
        path,
        expectedSha: loaded.sha,
        content: '新版本正文\n',
        message: '更新内容',
      });
      expect(written.contentSha).toBe((await readStudioFile(path)).sha);

      let history = await listStudioHistory(path);
      expect(history).toHaveLength(1);
      expect(await readStudioFileAtRef(path, history[0].sha)).toBe('旧版本正文\n');

      await deleteStudioFile(path, (await readStudioFile(path)).sha);
      history = await listStudioHistory(path);
      expect(history).toHaveLength(2);
      expect(history[0].message).toContain('Delete');
      expect(await readStudioFileAtRef(path, history[0].sha)).toBe('新版本正文\n');

      await writeStudioFile({
        path,
        expectedSha: null,
        content: await readStudioFileAtRef(path, history[1].sha),
        message: '恢复内容',
      });
      expect(await readFile(path, 'utf8')).toBe('旧版本正文\n');
    } finally {
      if (previousRuntime === undefined) delete process.env.STUDIO_RUNTIME_DIR;
      else process.env.STUDIO_RUNTIME_DIR = previousRuntime;
      await rm(root, { recursive: true, force: true });
    }
  });

  test('本地写入使用内容哈希拒绝过期和并发修改', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goumin-studio-conflict-'));
    const runtime = join(root, 'runtime');
    const path = join(root, 'entry.md');
    const previousRuntime = process.env.STUDIO_RUNTIME_DIR;
    process.env.STUDIO_RUNTIME_DIR = runtime;
    try {
      await writeFile(path, '初始版本\n', 'utf8');
      const expectedSha = (await readStudioFile(path)).sha;
      const attempts = await Promise.allSettled([
        writeStudioFile({ path, expectedSha, content: '编辑 A\n', message: '编辑 A' }),
        writeStudioFile({ path, expectedSha, content: '编辑 B\n', message: '编辑 B' }),
      ]);
      expect(attempts.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
      const rejected = attempts.find((entry) => entry.status === 'rejected');
      expect(rejected?.status === 'rejected' ? rejected.reason : undefined).toBeInstanceOf(
        StudioConflictError,
      );
      expect(['编辑 A\n', '编辑 B\n']).toContain(await readFile(path, 'utf8'));

      let staleError: unknown;
      try {
        await writeStudioFile({
          path,
          expectedSha,
          content: '过期覆盖\n',
          message: '过期覆盖',
        });
      } catch (error) {
        staleError = error;
      }
      expect(staleError).toBeInstanceOf(StudioConflictError);

      let staleDeleteError: unknown;
      try {
        await deleteStudioFile(path, expectedSha);
      } catch (error) {
        staleDeleteError = error;
      }
      expect(staleDeleteError).toBeInstanceOf(StudioConflictError);
      expect(['编辑 A\n', '编辑 B\n']).toContain(await readFile(path, 'utf8'));
    } finally {
      if (previousRuntime === undefined) delete process.env.STUDIO_RUNTIME_DIR;
      else process.env.STUDIO_RUNTIME_DIR = previousRuntime;
      await rm(root, { recursive: true, force: true });
    }
  });

  test('二进制素材以 base64 备份且不进入文本历史', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goumin-studio-binary-'));
    const runtime = join(root, 'runtime');
    const path = join(root, 'src/assets/images/content/test.png');
    const previousRuntime = process.env.STUDIO_RUNTIME_DIR;
    process.env.STUDIO_RUNTIME_DIR = runtime;
    try {
      const content = Buffer.from([0, 255, 1, 128, 64]);
      await mkdir(join(root, 'src/assets/images/content'), { recursive: true });
      await writeFile(path, content);
      const [asset] = await listStudioAssets(undefined, root);
      expect(asset.sha).toMatch(/^[a-f0-9]{64}$/);
      expect(asset.size).toBe(content.byteLength);
      expect(await studioFileExists(path)).toBe(true);
      await deleteStudioFile(path, asset.sha);
      expect(await studioFileExists(path)).toBe(false);

      expect(await listStudioHistory(path)).toEqual([]);
      const backups = await readdir(join(runtime, 'backups'));
      expect(backups).toHaveLength(1);
      const backup = JSON.parse(await readFile(join(runtime, 'backups', backups[0]), 'utf8'));
      expect(backup.encoding).toBe('base64');
      expect(Buffer.from(backup.content, 'base64')).toEqual(content);
    } finally {
      if (previousRuntime === undefined) delete process.env.STUDIO_RUNTIME_DIR;
      else process.env.STUDIO_RUNTIME_DIR = previousRuntime;
      await rm(root, { recursive: true, force: true });
    }
  });

  test('本地素材同名并发上传只允许一次创建', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goumin-studio-asset-create-'));
    const path = join(root, 'src/assets/images/content/same.png');
    try {
      const attempts = await Promise.allSettled([
        writeStudioBinaryFile({
          path,
          content: Buffer.from([1, 2, 3]),
          message: '上传 A',
        }),
        writeStudioBinaryFile({
          path,
          content: Buffer.from([4, 5, 6]),
          message: '上传 B',
        }),
      ]);
      expect(attempts.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
      const rejected = attempts.find((entry) => entry.status === 'rejected');
      expect(rejected?.status === 'rejected' ? rejected.reason : undefined).toBeInstanceOf(
        StudioConflictError,
      );
      expect([Buffer.from([1, 2, 3]), Buffer.from([4, 5, 6])]).toContainEqual(await readFile(path));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
