import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { initSiteSearch, type PagefindModule } from './site-search';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

function result(title: string) {
  return {
    url: `/blog/${title}/`,
    meta: { title },
    excerpt: `${title} excerpt`,
  };
}

const markup = `
  <div
    data-site-search-root
    data-search-max-results="6"
    data-search-idle-label="输入关键词开始搜索。"
    data-search-loading-label="搜索中..."
    data-search-empty-label="没有找到笔记。"
    data-search-unavailable-label="搜索不可用。"
  >
    <button data-site-search-trigger aria-expanded="false">搜索</button>
    <div data-site-search-layer data-site-search-backdrop aria-hidden="true" hidden inert>
      <section data-site-search-dialog>
        <input data-site-search-input type="search" aria-label="搜索站点" />
        <p data-site-search-status role="status" aria-live="polite" aria-atomic="true">
          输入关键词开始搜索。
        </p>
        <ol data-site-search-results></ol>
      </section>
    </div>
  </div>`;

function element(window: Window, selector: string) {
  return window.document.querySelector(selector) as any;
}

function submit(window: Window, input: HTMLInputElement, query: string) {
  input.value = query;
  input.dispatchEvent(
    new window.KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }) as any,
  );
}

async function flushAsyncWork() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe('站内搜索', () => {
  test('迟到的旧查询响应不会覆盖最新结果', async () => {
    const window = new Window({ url: 'https://goumin.work/' });
    window.document.body.innerHTML = markup;

    const previousWindow = (globalThis as { window?: unknown }).window;
    const previousDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { window?: unknown }).window = window;
    (globalThis as { document?: unknown }).document = window.document;

    const oldResult = deferred<ReturnType<typeof result>>();
    const pagefind: PagefindModule = {
      search: async (query) => ({
        results: [
          {
            id: query,
            data: query === 'old' ? () => oldResult.promise : async () => result(query),
          },
        ],
      }),
    };

    try {
      initSiteSearch({ loadSearchIndex: async () => pagefind });
      const input = element(window, '[data-site-search-input]');
      const results = element(window, '[data-site-search-results]');
      const status = element(window, '[data-site-search-status]');

      submit(window, input, 'old');
      await flushAsyncWork();

      submit(window, input, 'new');
      await flushAsyncWork();

      expect(results.textContent).toContain('new');
      expect(results.textContent).not.toContain('old');
      expect(status.textContent).toBe('1 result');

      oldResult.resolve(result('old'));
      await flushAsyncWork();

      expect(results.textContent).toContain('new');
      expect(results.textContent).not.toContain('old');
      expect(status.textContent).toBe('1 result');
    } finally {
      (globalThis as { window?: unknown }).window = previousWindow;
      (globalThis as { document?: unknown }).document = previousDocument;
      window.close();
    }
  });

  test('只渲染同源 http(s) 的公开结果', async () => {
    const window = new Window({ url: 'https://goumin.work/' });
    window.document.body.innerHTML = markup;

    const previousWindow = (globalThis as { window?: unknown }).window;
    const previousDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { window?: unknown }).window = window;
    (globalThis as { document?: unknown }).document = window.document;

    const urls = [
      'https://evil.example/blog/absolute-external/',
      '//evil.example/blog/protocol-relative-external/',
      'javascript:/blog/non-http/',
      'https://goumin.work/blog/same-origin/',
      '/projects/local-result/',
    ];
    const pagefind: PagefindModule = {
      search: async () => ({
        results: urls.map((url, index) => ({
          id: String(index),
          data: async () => ({
            url,
            meta: { title: `result-${index}` },
            excerpt: `excerpt-${index}`,
          }),
        })),
      }),
    };

    try {
      initSiteSearch({ loadSearchIndex: async () => pagefind });
      const input = element(window, '[data-site-search-input]');

      submit(window, input, 'result');
      await flushAsyncWork();

      const links = Array.from(
        window.document.querySelectorAll('[data-site-search-results] a'),
        (link) => (link as unknown as HTMLAnchorElement).href,
      );
      expect(links).toEqual([
        'https://goumin.work/blog/same-origin/',
        'https://goumin.work/projects/local-result/',
      ]);
      expect(window.document.querySelector('[data-site-search-status]')?.textContent).toBe(
        '2 results',
      );
    } finally {
      (globalThis as { window?: unknown }).window = previousWindow;
      (globalThis as { document?: unknown }).document = previousDocument;
      window.close();
    }
  });
});
