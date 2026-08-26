import { describe, expect, test } from 'bun:test';
import {
  getKeystaticCollectionUrl,
  getKeystaticCreateUrl,
  getKeystaticEntryUrl,
  getKeystaticSingletonUrl,
} from './keystatic-routes';

describe('Keystatic 路由', () => {
  test('本地模式使用无分支地址', () => {
    expect(getKeystaticCollectionUrl('blog')).toBe('/keystatic/collection/blog');
    expect(getKeystaticCreateUrl('projects')).toBe('/keystatic/collection/projects/create');
    expect(getKeystaticEntryUrl('vibe', 'today')).toBe('/keystatic/collection/vibe/item/today');
    expect(getKeystaticSingletonUrl('about')).toBe('/keystatic/singleton/about');
  });

  test('GitHub 模式包含分支并安全编码 slug', () => {
    const context = { branch: 'feature/content review' };
    expect(getKeystaticCreateUrl('blog', context)).toBe(
      '/keystatic/branch/feature%2Fcontent%20review/collection/blog/create',
    );
    expect(getKeystaticEntryUrl('blog', '中文 空格/路径', context)).toBe(
      '/keystatic/branch/feature%2Fcontent%20review/collection/blog/item/%E4%B8%AD%E6%96%87%20%E7%A9%BA%E6%A0%BC%2F%E8%B7%AF%E5%BE%84',
    );
    expect(getKeystaticSingletonUrl('about', { branch: 'main' })).toBe(
      '/keystatic/branch/main/singleton/about',
    );
  });
});
