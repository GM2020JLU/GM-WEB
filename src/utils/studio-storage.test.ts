import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deleteStudioFile,
  listStudioHistory,
  readStudioFileAtRef,
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
      await writeStudioFile({ path, content: '新版本正文\n', message: '更新内容' });

      let history = await listStudioHistory(path);
      expect(history).toHaveLength(1);
      expect(await readStudioFileAtRef(path, history[0].sha)).toBe('旧版本正文\n');

      await deleteStudioFile(path, undefined);
      history = await listStudioHistory(path);
      expect(history).toHaveLength(2);
      expect(history[0].message).toContain('Delete');
      expect(await readStudioFileAtRef(path, history[0].sha)).toBe('新版本正文\n');

      await writeStudioFile({
        path,
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
});
