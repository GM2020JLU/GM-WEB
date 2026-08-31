import { describe, expect, test } from 'bun:test';

import {
  ensureMainContentTarget,
  htmlFileToRoute,
  isPublicHtmlFile,
  isPublicPageRoute,
  normalizeRoutePath,
} from '../scripts/lib/public-routes.mjs';

describe('public route allowlist', () => {
  test('allows only the homepage and explicit public sections', () => {
    for (const route of [
      '/',
      '/about/',
      '/blog/post/',
      '/projects/example/',
      '/tags/linux/',
      '/vibe/',
      '/media/books/example/',
    ]) {
      expect(isPublicPageRoute(route)).toBe(true);
    }

    for (const route of [
      '/404',
      '/studio/',
      '/studio/edit/blog/post/',
      '/preview/render/blog/post/',
      '/keystatic/',
      '/api/studio/content/blog/post',
      '/resume/',
    ]) {
      expect(isPublicPageRoute(route)).toBe(false);
    }
  });

  test('strips a configured project base without accepting sibling paths', () => {
    expect(normalizeRoutePath('https://example.com/site/blog/', '/site')).toBe('/blog');
    expect(isPublicPageRoute('https://example.com/site/blog/', { basePath: '/site' })).toBe(true);
    expect(isPublicPageRoute('https://example.com/other/blog/', { basePath: '/site' })).toBe(false);
  });

  test('maps generated HTML files to routes before applying the allowlist', () => {
    expect(htmlFileToRoute('/dist/blog/post/index.html', '/dist')).toBe('/blog/post/');
    expect(isPublicHtmlFile('/dist/blog/post/index.html', '/dist')).toBe(true);
    expect(isPublicHtmlFile('/dist/preview/blog/post/index.html', '/dist')).toBe(false);
  });

  test('adds an idempotent, focusable skip-link target to an unowned main landmark', () => {
    const original = '<header></header><main class="page">content</main>';
    const normalized = ensureMainContentTarget(original);

    expect(normalized).toBe(
      '<header></header><main tabindex="-1" id="main-content" class="page">content</main>',
    );
    expect(ensureMainContentTarget(normalized)).toBe(normalized);
    expect(ensureMainContentTarget('<main id="article">content</main>')).toBe(
      '<main id="article">content</main>',
    );
  });
});
