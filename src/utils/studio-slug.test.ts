import { describe, expect, test } from 'bun:test';
import { generateStudioSlug } from './studio-slug';

describe('Studio 自动网址', () => {
  test('由中英文标题生成可用且稳定的网址别名', () => {
    const slug = generateStudioSlug('K3 Pico-ITX 风扇策略与配置指南');
    expect(slug).toMatch(/^k3-pico-itx-[a-z0-9-]+$/);
    expect(generateStudioSlug('K3 Pico-ITX 风扇策略与配置指南')).toBe(slug);
    expect(slug.length).toBeLessThanOrEqual(64);
  });
});
