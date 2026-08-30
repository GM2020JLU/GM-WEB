import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { setupStudioAssets } from './studio-assets-client';

const markup = `
  <label data-upload><input type="file" data-file></label>
  <div data-notice><strong></strong><small></small></div>
  <input type="search" data-search>
  <div data-assets></div>
  <p data-empty hidden></p>`;

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function element(window: Window, selector: string) {
  return window.document.querySelector(selector) as any;
}

describe('Studio 素材库交互', () => {
  test('加载、搜索并复制完整的嵌套素材引用', async () => {
    const window = new Window({ url: 'https://goumin.work/studio/assets' });
    window.document.body.innerHTML = markup;
    const copied: string[] = [];
    setupStudioAssets(window.document as unknown as Document, {
      fetch: async () =>
        Response.json({
          assets: [
            {
              name: 'heroImage.png',
              path: 'src/assets/images/content/demo/heroImage.png',
              size: 2048,
              url: '/hero.png',
            },
          ],
        }),
      writeClipboard: async (value) => {
        copied.push(value);
      },
    });
    await settle();

    const code = window.document.querySelector('code')!;
    expect(code.textContent).toBe('@assets/images/content/demo/heroImage.png');
    element(window, 'button').click();
    await settle();
    expect(copied).toEqual(['@assets/images/content/demo/heroImage.png']);
    expect(window.document.querySelector('[data-notice]')?.textContent).toContain('引用已复制');

    const search = element(window, '[data-search]');
    search.value = 'missing';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(element(window, '[data-empty]').hidden).toBe(false);
    expect(window.document.querySelector('[data-empty]')?.textContent).toContain('没有匹配');
  });

  test('阻止删除仍被内容引用的素材并展示引用位置', async () => {
    const window = new Window({ url: 'https://goumin.work/studio/assets' });
    window.document.body.innerHTML = markup;
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    setupStudioAssets(window.document as unknown as Document, {
      confirm: () => true,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ input: String(input), init });
        if (init?.method === 'DELETE') {
          return Response.json(
            {
              error: '素材仍被内容引用。',
              references: ['src/content/blog/demo.md'],
            },
            { status: 409 },
          );
        }
        return Response.json({
          assets: [
            {
              name: 'cover.png',
              path: 'src/assets/images/content/demo/cover.png',
              size: 100,
              url: '/cover.png',
            },
          ],
        });
      },
      writeClipboard: async () => {},
    });
    await settle();

    element(window, '.danger').click();
    await settle();
    expect(requests.some((request) => request.init?.method === 'DELETE')).toBe(true);
    expect(window.document.querySelector('[data-notice]')?.textContent).toContain('素材仍在使用');
    expect(window.document.querySelector('[data-notice]')?.textContent).toContain(
      'src/content/blog/demo.md',
    );
  });

  test('删除成功后将焦点移到相邻素材，空列表则回到搜索框', async () => {
    const window = new Window({ url: 'https://goumin.work/studio/assets' });
    window.document.body.innerHTML = markup;
    let assets = [
      {
        name: 'first.png',
        path: 'src/assets/images/content/first.png',
        size: 100,
        url: '/first.png',
      },
      {
        name: 'second.png',
        path: 'src/assets/images/content/second.png',
        size: 100,
        url: '/second.png',
      },
    ];
    setupStudioAssets(window.document as unknown as Document, {
      confirm: () => true,
      fetch: async (_input, init) => {
        if (init?.method === 'DELETE') {
          assets = assets.slice(1);
          return Response.json({ ok: true });
        }
        return Response.json({ assets });
      },
      writeClipboard: async () => {},
    });
    await settle();

    element(window, '.danger').click();
    await settle();
    expect(window.document.activeElement?.getAttribute('aria-label')).toBe(
      '复制 second.png 的素材引用',
    );

    element(window, '.danger').click();
    await settle();
    expect(window.document.activeElement).toBe(element(window, '[data-search]'));
  });

  test('复制失败时提供可手动复制的引用', async () => {
    const window = new Window({ url: 'https://goumin.work/studio/assets' });
    window.document.body.innerHTML = markup;
    setupStudioAssets(window.document as unknown as Document, {
      fetch: async () =>
        Response.json({
          assets: [
            {
              name: 'cover.png',
              path: 'src/assets/images/content/cover.png',
              size: 100,
              url: '/cover.png',
            },
          ],
        }),
      writeClipboard: async () => {
        throw new Error('denied');
      },
    });
    await settle();

    element(window, 'button').click();
    await settle();
    expect(window.document.querySelector('[data-notice]')?.getAttribute('role')).toBe('alert');
    expect(window.document.querySelector('[data-notice]')?.textContent).toContain(
      '@assets/images/content/cover.png',
    );
  });
});
