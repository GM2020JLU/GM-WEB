import { describe, expect, test } from 'bun:test';
import { verifyStudioOrigin } from './studio-api';

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
});
