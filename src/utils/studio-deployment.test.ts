import { describe, expect, test } from 'bun:test';
import {
  deploymentCopy,
  readPendingDeployment,
  resolveStudioDeploymentPhase,
  STUDIO_DEPLOYMENT_MAX_AGE_MS,
  STUDIO_DEPLOYMENT_STORAGE_KEY,
  type StudioDeploymentPhase,
} from './studio-deployment';

describe('Studio 发布进度', () => {
  test('为每个阶段提供清晰的中文提示与递增进度', () => {
    const phases: StudioDeploymentPhase[] = ['submitted', 'queued', 'building', 'ready', 'error'];
    const copies = phases.map((phase) => deploymentCopy({ phase, targetSha: 'a'.repeat(40) }));

    expect(copies.map((copy) => copy.title)).toEqual([
      '发布已提交',
      '等待开始构建',
      '正在构建网站',
      '网站已上线',
      '部署失败',
    ]);
    expect(copies.slice(0, 4).map((copy) => copy.progress)).toEqual([16, 38, 68, 100]);
  });

  test('本地发布使用 Mac 构建提示', () => {
    expect(
      deploymentCopy({ phase: 'queued', provider: 'local', targetSha: 'a'.repeat(40) }).detail,
    ).toContain('Mac');
    expect(
      deploymentCopy({ phase: 'building', provider: 'local', targetSha: 'a'.repeat(40) }).detail,
    ).toContain('45—90 秒');
  });

  test('只恢复具有合法提交 SHA 的待部署记录', () => {
    const pending = {
      targetSha: 'b'.repeat(40),
      startedAt: '2026-08-26T00:00:00.000Z',
      title: '测试文章',
      publicUrl: '/blog/test',
    };
    expect(
      readPendingDeployment(
        {
          getItem: (key) =>
            key === STUDIO_DEPLOYMENT_STORAGE_KEY ? JSON.stringify(pending) : null,
        },
        new Date('2026-08-26T00:30:00.000Z'),
      ),
    ).toEqual(pending);
    expect(readPendingDeployment({ getItem: () => '{"targetSha":"bad"}' })).toBeUndefined();
  });

  test('清除过期、未来或损坏的部署记录，避免页面无限轮询', () => {
    const removed: string[] = [];
    const storage = {
      getItem: () =>
        JSON.stringify({
          targetSha: 'd'.repeat(40),
          startedAt: '2026-08-26T00:00:00.000Z',
          title: '旧任务',
        }),
      removeItem: (key: string) => removed.push(key),
    };
    expect(
      readPendingDeployment(
        storage,
        new Date(new Date('2026-08-26T00:00:00.000Z').valueOf() + STUDIO_DEPLOYMENT_MAX_AGE_MS + 1),
      ),
    ).toBeUndefined();
    expect(removed).toEqual([STUDIO_DEPLOYMENT_STORAGE_KEY]);

    expect(
      readPendingDeployment(
        {
          getItem: () =>
            JSON.stringify({
              targetSha: 'd'.repeat(40),
              startedAt: '2026-08-26T01:00:00.000Z',
              title: '未来任务',
            }),
        },
        new Date('2026-08-26T00:00:00.000Z'),
      ),
    ).toBeUndefined();
  });

  test('以线上运行提交为最终完成依据，并识别构建失败', () => {
    const targetSha = 'c'.repeat(40);
    expect(resolveStudioDeploymentPhase({ targetSha, repositorySha: targetSha })).toBe('queued');
    expect(resolveStudioDeploymentPhase({ targetSha, deploymentSha: targetSha })).toBe('building');
    expect(
      resolveStudioDeploymentPhase({
        targetSha,
        deploymentSha: targetSha,
        deploymentState: 'failure',
      }),
    ).toBe('error');
    expect(resolveStudioDeploymentPhase({ targetSha, commitState: 'failure' })).toBe('error');
    expect(resolveStudioDeploymentPhase({ targetSha, commitState: 'pending' })).toBe('building');
    expect(resolveStudioDeploymentPhase({ targetSha, runtimeSha: targetSha })).toBe('ready');
  });
});
