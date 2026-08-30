import { describe, expect, test } from 'bun:test';
import {
  assertStudioContentSlug,
  resolveStudioCreateSlug,
  studioContentNeedsDeployment,
} from '../pages/api/studio/content/[collection]/[...slug]';

describe('Studio 内容路径', () => {
  test('新内容可生成标识，现有内容拒绝非原子重命名', () => {
    expect(() => assertStudioContentSlug('new', 'generated-slug', true)).not.toThrow();
    expect(() => assertStudioContentSlug('existing', 'existing', false)).not.toThrow();
    expect(() => assertStudioContentSlug('existing', 'renamed', false)).toThrow('不能');
  });

  test('新内容同名时自动选择下一个可用网址标识', async () => {
    const occupied = new Set(['same-title', 'same-title-2']);
    expect(await resolveStudioCreateSlug('same-title', async (slug) => occupied.has(slug))).toBe(
      'same-title-3',
    );
    expect(await resolveStudioCreateSlug('fresh-title', async () => false)).toBe('fresh-title');
  });

  test('已发布内容的任何变更、目标发布和分类变更都需要部署', () => {
    expect(studioContentNeedsDeployment(false, 'published', 'draft')).toBe(true);
    expect(studioContentNeedsDeployment(false, 'draft', 'published')).toBe(true);
    expect(studioContentNeedsDeployment(true, 'draft', 'draft')).toBe(true);
    expect(studioContentNeedsDeployment(false, 'draft', 'ready')).toBe(false);
  });
});
