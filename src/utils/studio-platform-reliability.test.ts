import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncStudioOffsiteBackups } from '../../scripts/local-backup';
import { restoreStudioOffsiteBackup } from '../../scripts/local-backup-restore';
import { createStudioBackupRecord } from './studio-backup-record';
import { readProductionBuildSha } from './studio-deployment';
import {
  localDeploymentState,
  prepareStudioLocalDeploymentIntent,
  readStudioLocalDeployment,
  replayStudioLocalDeploymentOutbox,
  startStudioLocalDeployment,
} from './studio-local-deployment';
import { acquireStudioRuntimeLease } from './studio-runtime-lock';
import { readStudioPlatformHealth } from './studio-platform-health';
import { studioStorageInternals } from './studio-storage';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe('Studio 运行锁', () => {
  test('活跃租约不会被抢占，释放后可继续获取', async () => {
    const root = await temporaryRoot('studio-lock-live-');
    const first = await acquireStudioRuntimeLease({
      name: 'test-live',
      purpose: 'first',
      repositoryRoot: root,
      staleMs: 0,
      timeoutMs: 200,
    });
    await expect(
      acquireStudioRuntimeLease({
        name: 'test-live',
        purpose: 'second',
        repositoryRoot: root,
        staleMs: 0,
        timeoutMs: 150,
      }),
    ).rejects.toThrow('超时');
    await first.release();
    const second = await acquireStudioRuntimeLease({
      name: 'test-live',
      purpose: 'second',
      repositoryRoot: root,
      timeoutMs: 200,
    });
    await second.release();
  });

  test('恢复无活跃进程的过期锁', async () => {
    const root = await temporaryRoot('studio-lock-stale-');
    const lock = join(root, '.studio/runtime/locks/test-stale.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(
      join(lock, 'owner.json'),
      JSON.stringify({
        acquiredAt: '2000-01-01T00:00:00.000Z',
        heartbeatAt: '2000-01-01T00:00:00.000Z',
        hostname: hostname(),
        pid: 2_147_483_647,
        purpose: 'crashed',
        version: 1,
      }),
    );
    const lease = await acquireStudioRuntimeLease({
      name: 'test-stale',
      purpose: 'recovered',
      repositoryRoot: root,
      staleMs: 1,
      timeoutMs: 500,
    });
    await lease.release();
  });

  test('并发续期与释放不会复活已释放的锁', async () => {
    const root = await temporaryRoot('studio-lock-race-');
    const lease = await acquireStudioRuntimeLease({
      name: 'test-race',
      purpose: 'race',
      repositoryRoot: root,
    });
    const lock = join(root, '.studio/runtime/locks/test-race.lock');
    const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
    expect(owner.token).toMatch(/^[a-f0-9]{32}$/);
    const renewals = Array.from({ length: 20 }, () => lease.renew());
    const release = lease.release();
    await Promise.all([...renewals, release]);
    await new Promise((accept) => setTimeout(accept, 10));
    expect(existsSync(lock)).toBe(false);
  });

  test('释放不会删除同进程但 token 不同的新租约', async () => {
    const root = await temporaryRoot('studio-lock-token-');
    const lease = await acquireStudioRuntimeLease({
      name: 'test-token',
      purpose: 'token ownership',
      repositoryRoot: root,
    });
    const lock = join(root, '.studio/runtime/locks/test-token.lock');
    const ownerPath = join(lock, 'owner.json');
    const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
    await writeFile(ownerPath, JSON.stringify({ ...owner, token: 'f'.repeat(32) }));
    await lease.release();
    expect(existsSync(lock)).toBe(true);
  });
});

describe('Studio 发布队列与生产标记', () => {
  test('请求只原子入队，不会为每个请求启动 detached worker', async () => {
    const root = await temporaryRoot('studio-queue-');
    const previousRuntime = process.env.STUDIO_RUNTIME_DIR;
    process.env.STUDIO_RUNTIME_DIR = join(root, 'runtime');
    try {
      const targetSha = await startStudioLocalDeployment('测试发布');
      expect(targetSha).toMatch(/^[a-f0-9]{40}$/);
      expect(await readStudioLocalDeployment(targetSha)).toMatchObject({
        phase: 'queued',
        provider: 'local',
        targetSha,
      });
      const intent = JSON.parse(await readFile(localDeploymentState.outboxPath(targetSha), 'utf8'));
      expect(intent).toMatchObject({ kind: 'deployment', phase: 'committed', reason: '测试发布' });
      await replayStudioLocalDeploymentOutbox();
      const request = JSON.parse(
        await readFile(localDeploymentState.pendingPath(targetSha), 'utf8'),
      );
      expect(request).toMatchObject({ kind: 'deployment', reason: '测试发布' });
      expect((await stat(localDeploymentState.pendingPath(targetSha))).mode & 0o777).toBe(0o600);
    } finally {
      if (previousRuntime === undefined) delete process.env.STUDIO_RUNTIME_DIR;
      else process.env.STUDIO_RUNTIME_DIR = previousRuntime;
    }
  });

  test('未 commit 的 outbox 在启动时也保守重放', async () => {
    const root = await temporaryRoot('studio-outbox-replay-');
    const previousRuntime = process.env.STUDIO_RUNTIME_DIR;
    process.env.STUDIO_RUNTIME_DIR = join(root, 'runtime');
    try {
      const id = await prepareStudioLocalDeploymentIntent('SIGKILL 恢复');
      expect(existsSync(localDeploymentState.pendingPath(id))).toBe(false);
      expect(await replayStudioLocalDeploymentOutbox()).toEqual([id]);
      const request = JSON.parse(await readFile(localDeploymentState.pendingPath(id), 'utf8'));
      expect(request).toMatchObject({ id, reason: 'SIGKILL 恢复' });
    } finally {
      if (previousRuntime === undefined) delete process.env.STUDIO_RUNTIME_DIR;
      else process.env.STUDIO_RUNTIME_DIR = previousRuntime;
    }
  });

  test('内容可能已落盘后的错误保留 prepared intent', async () => {
    const root = await temporaryRoot('studio-outbox-write-failure-');
    const previousRuntime = process.env.STUDIO_RUNTIME_DIR;
    process.env.STUDIO_RUNTIME_DIR = join(root, 'runtime');
    const durableFile = join(root, 'content-written');
    try {
      await expect(
        studioStorageInternals.withLocalDeploymentIntent(
          { deploy: true, reason: '写后备份失败' },
          async () => {
            await writeFile(durableFile, '已落盘');
            throw new Error('模拟 offsite 失败');
          },
        ),
      ).rejects.toThrow('offsite');
      expect(await readFile(durableFile, 'utf8')).toBe('已落盘');
      const outbox = await readdir(join(root, 'runtime/deployment-queue/outbox'));
      expect(outbox).toHaveLength(1);
      await replayStudioLocalDeploymentOutbox();
      expect(await readdir(join(root, 'runtime/deployment-queue/pending'))).toHaveLength(1);
    } finally {
      if (previousRuntime === undefined) delete process.env.STUDIO_RUNTIME_DIR;
      else process.env.STUDIO_RUNTIME_DIR = previousRuntime;
    }
  });

  test('批量的每个独立写入都有可追踪的最终部署意图', async () => {
    const root = await temporaryRoot('studio-outbox-bulk-');
    const previousRuntime = process.env.STUDIO_RUNTIME_DIR;
    process.env.STUDIO_RUNTIME_DIR = join(root, 'runtime');
    try {
      const first = await studioStorageInternals.withLocalDeploymentIntent(
        { deploy: true, reason: 'Bulk publish: 2 entries' },
        async () => ({ path: 'first' }),
      );
      const second = await studioStorageInternals.withLocalDeploymentIntent(
        { deploy: true, reason: 'Bulk publish: 2 entries' },
        async () => ({ path: 'second' }),
      );
      expect(second.localDeploymentId).not.toBe(first.localDeploymentId);
      expect(await readdir(join(root, 'runtime/deployment-queue/outbox'))).toHaveLength(2);
    } finally {
      if (previousRuntime === undefined) delete process.env.STUDIO_RUNTIME_DIR;
      else process.env.STUDIO_RUNTIME_DIR = previousRuntime;
    }
  });

  test('只接受生产域名返回的精确 40 位 SHA', async () => {
    const originalFetch = globalThis.fetch;
    const targetSha = 'a'.repeat(40);
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ schemaVersion: 1, sha: targetSha }), {
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;
    try {
      expect(await readProductionBuildSha('https://example.com')).toBe(targetSha);
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ sha: 'preview' }))) as unknown as typeof fetch;
      expect(await readProductionBuildSha('https://example.com')).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Studio 离机备份', () => {
  test('迁移早期缺少 encoding 的 UTF-8 历史记录且仍校验原始摘要', async () => {
    const root = await temporaryRoot('studio-offsite-legacy-');
    const runtime = join(root, 'runtime');
    const source = join(runtime, 'backups');
    const destination = join(root, 'icloud-drive');
    await mkdir(source, { recursive: true });
    const legacy = {
      content: '早期草稿',
      date: '2026-08-27T01:00:00.000Z',
      message: '旧版保存',
      path: 'src/content/blog/legacy.md',
      sha: '',
    };
    legacy.sha = createHash('sha1')
      .update(`${legacy.path}\0${legacy.date}\0${legacy.content}`)
      .digest('hex');
    await writeFile(join(source, `${legacy.sha}.json`), JSON.stringify(legacy));

    expect(
      await syncStudioOffsiteBackups({
        destination,
        repositoryRoot: root,
        runtimeDirectory: runtime,
      }),
    ).toMatchObject({ copied: 1, retained: 1 });
    expect(await restoreStudioOffsiteBackup(destination, join(root, 'restore'))).toEqual({
      restored: 1,
      tombstones: 0,
    });
    expect(await readFile(join(root, 'restore/src/content/blog/legacy.md'), 'utf8')).toBe(
      legacy.content,
    );
  });

  test('首次草稿备份原子复制到独立目录并记录成功时间', async () => {
    const root = await temporaryRoot('studio-offsite-');
    const runtime = join(root, 'runtime');
    const source = join(runtime, 'backups');
    const pending = join(runtime, 'offsite-pending');
    const destination = join(root, 'icloud-drive');
    await Promise.all([mkdir(source, { recursive: true }), mkdir(pending, { recursive: true })]);
    const history = createStudioBackupRecord({
      content: '草稿的上一版',
      date: '2026-08-31T07:00:00.000Z',
      encoding: 'utf8',
      kind: 'history',
      message: '保存草稿',
      path: 'src/content/blog/draft.md',
    });
    const current = createStudioBackupRecord({
      content: '首次保存的草稿',
      date: '2026-08-31T08:00:00.000Z',
      encoding: 'utf8',
      kind: 'snapshot',
      message: '保存草稿',
      path: 'src/content/blog/first-draft.md',
    });
    await Promise.all([
      writeFile(join(source, `${history.sha}.json`), JSON.stringify(history)),
      writeFile(join(pending, `${current.sha}.json`), JSON.stringify(current)),
    ]);
    const result = await syncStudioOffsiteBackups({
      destination,
      now: new Date('2026-08-31T08:01:00.000Z'),
      repositoryRoot: root,
      runtimeDirectory: runtime,
    });
    expect(result).toMatchObject({ copied: 2, retained: 2 });
    expect(await readFile(join(destination, `${current.sha}.json`), 'utf8')).toContain(
      '首次保存的草稿',
    );
    expect(await readdir(pending)).toEqual([]);
    expect((await stat(destination)).mode & 0o777).toBe(0o700);
    expect((await stat(join(destination, `${history.sha}.json`))).mode & 0o777).toBe(0o600);
    const state = JSON.parse(await readFile(join(runtime, 'offsite-backup-state.json'), 'utf8'));
    expect(state).toMatchObject({
      copied: 2,
      lastSuccessAt: '2026-08-31T08:01:00.000Z',
      retained: 2,
    });
  });

  test('恢复只写入空目录并按最新删除标记跳过旧文件', async () => {
    const root = await temporaryRoot('studio-restore-');
    const source = join(root, 'icloud');
    const output = join(root, 'restored');
    await mkdir(source, { recursive: true });
    const records = [
      createStudioBackupRecord({
        content: '旧草稿',
        date: '2026-08-31T09:00:00.000Z',
        encoding: 'utf8',
        kind: 'snapshot',
        message: '保存',
        path: 'src/content/blog/deleted.md',
      }),
      createStudioBackupRecord({
        content: '',
        date: '2026-08-31T09:00:00.000Z',
        deleted: true,
        encoding: 'utf8',
        kind: 'tombstone',
        message: '删除',
        path: 'src/content/blog/deleted.md',
      }),
      createStudioBackupRecord({
        content: 'title = "Recovered"\n',
        date: '2026-08-31T09:00:00.000Z',
        encoding: 'utf8',
        kind: 'snapshot',
        message: '保存设置',
        path: 'src/config/site.toml',
      }),
    ];
    await Promise.all(
      records.map((record) =>
        writeFile(join(source, `${record.sha}.json`), JSON.stringify(record)),
      ),
    );
    expect(await restoreStudioOffsiteBackup(source, output)).toEqual({
      restored: 1,
      tombstones: 1,
    });
    expect(await readFile(join(output, 'src/config/site.toml'), 'utf8')).toContain('Recovered');
    await writeFile(join(output, 'occupied'), 'do not overwrite');
    await expect(restoreStudioOffsiteBackup(source, output)).rejects.toThrow('必须不存在或为空');
  });

  test('同名远端记录不一致时报错且不确认 pending', async () => {
    const root = await temporaryRoot('studio-offsite-conflict-');
    const runtime = join(root, 'runtime');
    const pending = join(runtime, 'offsite-pending');
    const destination = join(root, 'icloud');
    await Promise.all([
      mkdir(pending, { recursive: true }),
      mkdir(destination, { recursive: true }),
    ]);
    const record = createStudioBackupRecord({
      content: '本地草稿',
      date: '2026-08-31T08:00:00.000Z',
      encoding: 'utf8',
      kind: 'snapshot',
      message: '保存',
      path: 'src/content/blog/conflict.md',
    });
    await writeFile(join(pending, `${record.sha}.json`), JSON.stringify(record));
    await writeFile(
      join(destination, `${record.sha}.json`),
      JSON.stringify({ ...record, content: '被篡改' }),
    );
    await expect(
      syncStudioOffsiteBackups({ destination, repositoryRoot: root, runtimeDirectory: runtime }),
    ).rejects.toThrow();
    expect(existsSync(join(pending, `${record.sha}.json`))).toBe(true);
  });

  test('全局裁剪始终保留每个路径的最新快照或删除标记', async () => {
    const root = await temporaryRoot('studio-offsite-retention-');
    const runtime = join(root, 'runtime');
    const destination = join(root, 'icloud');
    await mkdir(destination, { recursive: true });
    const records = [
      createStudioBackupRecord({
        content: '旧版',
        date: '2020-01-01T00:00:00.000Z',
        encoding: 'utf8',
        kind: 'snapshot',
        message: '旧版',
        path: 'src/content/blog/a.md',
      }),
      createStudioBackupRecord({
        content: '最新版',
        date: '2021-01-01T00:00:00.000Z',
        encoding: 'utf8',
        kind: 'snapshot',
        message: '最新版',
        path: 'src/content/blog/a.md',
      }),
      createStudioBackupRecord({
        content: '',
        date: '2021-02-01T00:00:00.000Z',
        deleted: true,
        encoding: 'utf8',
        kind: 'tombstone',
        message: '删除',
        path: 'src/content/blog/b.md',
      }),
    ];
    await Promise.all(
      records.map((record) =>
        writeFile(join(destination, `${record.sha}.json`), JSON.stringify(record)),
      ),
    );
    const result = await syncStudioOffsiteBackups({
      destination,
      maximumAgeMs: 0,
      maximumEntries: 1,
      now: new Date('2026-08-31T00:00:00.000Z'),
      repositoryRoot: root,
      runtimeDirectory: runtime,
    });
    expect(result.retained).toBe(2);
    expect(existsSync(join(destination, `${records[0].sha}.json`))).toBe(false);
    expect(existsSync(join(destination, `${records[1].sha}.json`))).toBe(true);
    expect(existsSync(join(destination, `${records[2].sha}.json`))).toBe(true);
  });

  test('全新空仓也记录一次成功备份', async () => {
    const root = await temporaryRoot('studio-offsite-empty-');
    const runtime = join(root, 'runtime');
    const destination = join(root, 'icloud');
    expect(
      await syncStudioOffsiteBackups({
        destination,
        now: new Date('2026-08-31T12:00:00.000Z'),
        repositoryRoot: root,
        runtimeDirectory: runtime,
      }),
    ).toMatchObject({ copied: 0, retained: 0 });
    expect(
      JSON.parse(await readFile(join(runtime, 'offsite-backup-state.json'), 'utf8')),
    ).toMatchObject({ lastSuccessAt: '2026-08-31T12:00:00.000Z', retained: 0 });
  });

  test('恢复前重新校验文件名、SHA 与内容', async () => {
    const root = await temporaryRoot('studio-restore-tampered-');
    const source = join(root, 'icloud');
    await mkdir(source, { recursive: true });
    const record = createStudioBackupRecord({
      content: '原始内容',
      date: '2026-08-31T10:00:00.000Z',
      encoding: 'utf8',
      kind: 'snapshot',
      message: '保存',
      path: 'src/content/blog/tampered.md',
    });
    await writeFile(
      join(source, `${record.sha}.json`),
      JSON.stringify({ ...record, content: '被篡改的内容' }),
    );
    await expect(restoreStudioOffsiteBackup(source, join(root, 'restore'))).rejects.toThrow(
      '校验失败',
    );
  });

  test('本地历史恢复也拒绝被篡改的记录', async () => {
    const root = await temporaryRoot('studio-history-tampered-');
    const previousRuntime = process.env.STUDIO_RUNTIME_DIR;
    process.env.STUDIO_RUNTIME_DIR = join(root, 'runtime');
    const backupRoot = join(root, 'runtime/backups');
    await mkdir(backupRoot, { recursive: true });
    const record = createStudioBackupRecord({
      content: '可恢复内容',
      date: '2026-08-31T10:00:00.000Z',
      encoding: 'utf8',
      kind: 'history',
      message: '保存',
      path: 'src/content/blog/history.md',
    });
    await writeFile(
      join(backupRoot, `${record.sha}.json`),
      JSON.stringify({ ...record, content: '被篡改' }),
    );
    try {
      await expect(studioStorageInternals.readLocalBackup(record.path, record.sha)).rejects.toThrow(
        '找不到',
      );
    } finally {
      if (previousRuntime === undefined) delete process.env.STUDIO_RUNTIME_DIR;
      else process.env.STUDIO_RUNTIME_DIR = previousRuntime;
    }
  });
});

describe('Studio 平台健康状态', () => {
  test('返回 production、worker、scheduler 与 backup 的时间和错误', async () => {
    const root = await temporaryRoot('studio-health-');
    const runtime = join(root, '.studio/runtime');
    await mkdir(join(runtime, 'locks/deployment-worker.lock'), { recursive: true });
    await Promise.all([
      writeFile(
        join(runtime, 'locks/deployment-worker.lock/owner.json'),
        JSON.stringify({ heartbeatAt: '2026-08-31T11:59:50.000Z' }),
      ),
      writeFile(
        join(runtime, 'scheduler-state.json'),
        JSON.stringify({
          lastFinishedAt: '2026-08-31T11:59:00.000Z',
          phase: 'idle',
        }),
      ),
      writeFile(
        join(runtime, 'offsite-backup-state.json'),
        JSON.stringify({
          error: 'iCloud 不可用',
          lastAttemptAt: '2026-08-31T11:58:00.000Z',
        }),
      ),
    ]);
    const health = await readStudioPlatformHealth({
      expectedProductionSha: 'a'.repeat(40),
      now: new Date('2026-08-31T12:00:00.000Z'),
      readProductionSha: async () => 'a'.repeat(40),
      repositoryRoot: root,
    });
    expect(health.production).toMatchObject({ status: 'healthy', url: 'https://goumin.work' });
    expect(health.worker).toMatchObject({
      checkedAt: '2026-08-31T11:59:50.000Z',
      status: 'healthy',
    });
    expect(health.scheduler).toMatchObject({ status: 'healthy' });
    expect(health.backup).toMatchObject({ status: 'error' });
    expect(health.backup.detail).toContain('iCloud 不可用');
  });

  test('生产 marker 可达但与期望版本不一致时不显示绿灯', async () => {
    const root = await temporaryRoot('studio-health-sha-');
    const health = await readStudioPlatformHealth({
      expectedProductionSha: 'b'.repeat(40),
      now: new Date('2026-08-31T12:00:00.000Z'),
      readProductionSha: async () => 'a'.repeat(40),
      repositoryRoot: root,
    });
    expect(health.production.status).toBe('warning');
    expect(health.production.detail).toContain('期望 bbbbbbb');
  });
});

describe('Caddy 边缘安全配置', () => {
  test('不覆盖鉴权服务的更严响应头，且跳过 OAuth 凭据日志', async () => {
    const source = await readFile(join(process.cwd(), 'deploy/macos/Caddyfile'), 'utf8');
    expect(source).toContain('header ?Strict-Transport-Security');
    expect(source).toContain('header ?X-Content-Type-Options');
    expect(source).toContain('header ?X-Frame-Options "SAMEORIGIN"');
    expect(source).toContain('header ?Referrer-Policy "strict-origin-when-cross-origin"');
    expect(source).toContain('header ?Permissions-Policy');
    expect(source).toContain('log_skip @credentialBearingAuth');
    expect(source).toContain('/api/studio/auth/github/callback');
  });
});
