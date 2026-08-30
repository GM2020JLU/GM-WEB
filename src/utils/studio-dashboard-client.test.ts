import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { STUDIO_DEPLOYMENT_STORAGE_KEY } from './studio-deployment';
import { setupStudioDashboard } from './studio-dashboard-client';

const markup = `
  <button data-filter="all" aria-pressed="true">全部</button>
  <button data-filter="draft">草稿</button>
  <input data-search><select data-type-filter><option value="all">全部</option></select>
  <section data-row data-status="published" data-type="博客" data-health="good">文章 A<input type="checkbox" data-select-item data-collection="blog" data-slug="a" data-revision="2026-08-30T10:00:00+08:00"></section>
  <section data-row data-status="draft" data-type="博客" data-health="good">文章 B<input type="checkbox" data-select-item data-collection="blog" data-slug="b"></section>
  <p data-empty hidden></p>
  <p data-selection-announcement aria-live="polite"></p>
  <div data-bulk-bar hidden><span data-selected-count></span><button data-bulk-action="draft"></button></div>
  <div data-bulk-feedback hidden></div>
  <section data-deployment><strong data-deployment-title></strong><small data-deployment-detail></small><div data-deployment-track hidden><span data-deployment-progress></span></div><a data-deployment-link hidden></a></section>`;

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function element(window: Window, selector: string) {
  return window.document.querySelector(selector) as any;
}

describe('Studio 内容总览交互', () => {
  test('筛选时清除隐藏条目的选择，避免误批量操作', () => {
    const window = new Window({ url: 'https://goumin.work/studio' });
    window.document.body.innerHTML = markup;
    setupStudioDashboard(window.document as unknown as Document, {
      fetch: async () => new Response(),
    });
    const first = element(window, '[data-slug="a"]');
    first.checked = true;
    first.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(window.document.querySelector('[data-selected-count]')?.textContent).toBe('1');

    element(window, '[data-filter="draft"]').click();
    expect(first.checked).toBe(false);
    expect(element(window, '[data-bulk-bar]').hidden).toBe(true);
    expect(element(window, '[data-selection-announcement]').textContent).toContain(
      '已取消全部选择',
    );
  });

  test('通过 aria-live 明确宣布选择数量和批量操作位置', () => {
    const window = new Window({ url: 'https://goumin.work/studio' });
    window.document.body.innerHTML = markup;
    setupStudioDashboard(window.document as unknown as Document, {
      fetch: async () => new Response(),
    });
    const first = element(window, '[data-slug="a"]');
    first.checked = true;
    first.dispatchEvent(new window.Event('change', { bubbles: true }));

    expect(element(window, '[data-selection-announcement]').textContent).toBe(
      '已选择 1 条内容。批量操作已显示在内容列表上方。',
    );
  });

  test('批量转草稿记录部署并刷新列表', async () => {
    const window = new Window({ url: 'https://goumin.work/studio' });
    window.document.body.innerHTML = markup;
    let reloaded = false;
    let submitted: Record<string, any> | undefined;
    setupStudioDashboard(window.document as unknown as Document, {
      confirm: () => true,
      fetch: async (_input, init) => {
        submitted = JSON.parse(String(init?.body));
        return Response.json({
          ok: true,
          status: 'draft',
          updated: 1,
          commitSha: 'a'.repeat(40),
          deploymentPending: true,
        });
      },
      reload: () => {
        reloaded = true;
      },
    });
    const first = element(window, '[data-slug="a"]');
    first.checked = true;
    first.dispatchEvent(new window.Event('change', { bubbles: true }));
    element(window, '[data-bulk-action]').click();
    await settle();

    expect(reloaded).toBe(true);
    expect(submitted?.items[0]).toEqual({
      collection: 'blog',
      expectedUpdatedDate: '2026-08-30T10:00:00+08:00',
      slug: 'a',
    });
    expect(window.localStorage.getItem(STUDIO_DEPLOYMENT_STORAGE_KEY)).toContain('a'.repeat(40));
  });

  test('部分成功会明确反馈并提供刷新入口', async () => {
    const window = new Window({ url: 'https://goumin.work/studio' });
    window.document.body.innerHTML = markup;
    setupStudioDashboard(window.document as unknown as Document, {
      confirm: () => true,
      fetch: async () =>
        Response.json(
          { ok: false, partial: true, updated: 1, error: '后续操作遇到冲突。' },
          { status: 207 },
        ),
      reload: () => {},
    });
    const first = element(window, '[data-slug="a"]');
    first.checked = true;
    first.dispatchEvent(new window.Event('change', { bubbles: true }));
    element(window, '[data-bulk-action]').click();
    await settle();

    expect(window.document.querySelector('[data-bulk-feedback]')?.textContent).toContain(
      '部分内容已更新',
    );
    expect(window.document.querySelector('[data-bulk-feedback] button')?.textContent).toBe(
      '刷新列表',
    );
  });
});
