import { describe, expect, test } from 'bun:test';
import {
  resolveStudioStorageToken,
  StudioAuthenticationError,
  studioApiError,
  studioDeploymentMetadata,
  verifyStudioOrigin,
} from './studio-api';
import { StudioConflictError } from './studio-storage';

describe('Studio 请求来源校验', () => {
  test('接受同源请求与可信代理转发后的外部来源', () => {
    const internalUrl = new URL('http://127.0.0.1:4321/api/studio/import');
    expect(
      verifyStudioOrigin(
        new Request(internalUrl, { headers: { Origin: 'http://127.0.0.1:4321' } }),
        internalUrl,
      ),
    ).toBe(true);
    expect(
      verifyStudioOrigin(
        new Request(internalUrl, {
          headers: {
            Origin: 'https://studio.goumin.work',
            'X-Forwarded-Host': 'studio.goumin.work',
            'X-Forwarded-Proto': 'https',
          },
        }),
        internalUrl,
      ),
    ).toBe(true);
    expect(
      verifyStudioOrigin(
        new Request(internalUrl, {
          headers: {
            Host: 'goumin-mac.tailfc8e48.ts.net',
            Origin: 'https://goumin-mac.tailfc8e48.ts.net',
          },
        }),
        internalUrl,
      ),
    ).toBe(true);
    expect(
      verifyStudioOrigin(
        new Request(internalUrl, {
          headers: {
            Host: 'mac-preview.goumin.work',
            Origin: 'https://mac-preview.goumin.work',
          },
        }),
        internalUrl,
      ),
    ).toBe(true);
  });

  test('拒绝与代理转发地址不一致的来源', () => {
    const internalUrl = new URL('http://127.0.0.1:4321/api/studio/import');
    expect(
      verifyStudioOrigin(
        new Request(internalUrl, {
          headers: {
            Origin: 'https://attacker.example',
            'X-Forwarded-Host': 'studio.goumin.work',
            'X-Forwarded-Proto': 'https',
          },
        }),
        internalUrl,
      ),
    ).toBe(false);
  });

  test('拒绝攻击者伪造与 Origin 一致的转发主机', () => {
    const internalUrl = new URL('http://127.0.0.1:4321/api/studio/content/blog/test');
    expect(
      verifyStudioOrigin(
        new Request(internalUrl, {
          headers: {
            Origin: 'https://attacker.example',
            'X-Forwarded-Host': 'attacker.example',
            'X-Forwarded-Proto': 'https',
          },
        }),
        internalUrl,
      ),
    ).toBe(false);
  });

  test('乐观锁冲突返回 409 而不是服务器错误', async () => {
    const response = studioApiError(new StudioConflictError());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('已被修改') });
  });

  test('本地存储模式忽略浏览器里遗留的 GitHub OAuth cookie', () => {
    expect(resolveStudioStorageToken('stale-oauth-token', false)).toBeUndefined();
    expect(resolveStudioStorageToken('active-oauth-token', true)).toBe('active-oauth-token');
    expect(() => resolveStudioStorageToken(undefined, true)).toThrow(StudioAuthenticationError);
  });

  test('GitHub 分支上的草稿提交也会进入 Vercel 部署跟踪', async () => {
    expect(
      await studioDeploymentMetadata({
        token: 'github-token',
        commitSha: 'a'.repeat(40),
        deploy: false,
        reason: 'Save draft',
      }),
    ).toMatchObject({
      commitSha: 'a'.repeat(40),
      deploymentPending: true,
      deploymentProvider: 'vercel',
    });
    expect(
      await studioDeploymentMetadata({
        commitSha: 'b'.repeat(64),
        deploy: false,
        reason: 'Save local draft',
      }),
    ).toMatchObject({ deploymentPending: false });
  });
});
