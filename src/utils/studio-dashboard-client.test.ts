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
  <section data-deployment><strong data-deployment-title>正在检查</strong><small data-deployment-detail></small><div data-deployment-track hidden><span data-deployment-progress></span></div><a data-deployment-link hidden></a></section>
  <section data-platform-health aria-busy="true">
    ${['production', 'worker', 'scheduler', 'backup']
      .map(
        (key) =>
          `<article data-platform-health-item="${key}" data-status="unknown"><small data-health-detail></small><time data-health-time></time><a data-health-link hidden></a></article>`,
      )
      .join('')}
  </section>`;

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function element(window: Window, selector: string) {
  return window.document.querySelector(selector) as any;
}

describe('Studio 内容总览交互', () => {
  test('无本地待部署记录时也会主动读取并展示平台健康状态', async () => {
    const window = new Window({ url: 'https://goumin.work/studio' });
    window.document.body.innerHTML = markup;
    const requests: string[] = [];
    setupStudioDashboard(window.document as unknown as Document, {
      fetch: async (input) => {
        requests.push(String(input));
        return Response.json({
          deployment: {
            phase: 'ready',
            provider: 'local',
            targetSha: '0'.repeat(40),
            updatedAt: '2026-08-31T08:00:00+08:00',
          },
          health: {
            production: {
              status: 'healthy',
              checkedAt: '2026-08-31T08:00:00+08:00',
              detail: '生产 marker d3965af 已验证。',
            },
            worker: {
              status: 'healthy',
              checkedAt: '2026-08-31T08:01:00+08:00',
              detail: 'Worker 心跳正常。',
            },
            scheduler: {
              status: 'warning',
              checkedAt: '2026-08-31T07:55:00+08:00',
              detail: '定时任务尚未到期。',
            },
            backup: {
              status: 'healthy',
              checkedAt: '2026-08-31T07:30:00+08:00',
              detail: '离机备份已完成。',
              url: '/studio/backup-log',
            },
          },
        });
      },
    });
    await settle();

    expect(requests).toContain('/api/studio/deployment');
    expect(element(window, '[data-deployment-title]').textContent).toContain('需要关注');
    expect(element(window, '[data-platform-health]').getAttribute('aria-busy')).toBe('false');
    expect(
      element(window, '[data-platform-health-item="production"] [data-health-detail]').textContent,
    ).toContain('marker');
    expect(element(window, '[data-platform-health-item="worker"]').dataset.status).toBe('healthy');
    expect(element(window, '[data-platform-health-item="scheduler"]').dataset.status).toBe(
      'warning',
    );
    expect(
      element(window, '[data-platform-health-item="backup"] [data-health-time]').textContent,
    ).toContain('最近检查');
    expect(element(window, '[data-platform-health-item="backup"] [data-health-link]').hidden).toBe(
      false,
    );
  });

  test('带 SHA 的任务轮询不会把独立健康检查重置为 unknown', async () => {
    const window = new Window({ url: 'https://goumin.work/studio' });
    window.document.body.innerHTML = markup;
    window.localStorage.setItem(
      STUDIO_DEPLOYMENT_STORAGE_KEY,
      JSON.stringify({
        startedAt: new Date().toISOString(),
        targetSha: 'a'.repeat(40),
        title: '待部署文章',
      }),
    );
    let finishPoll: (() => void) | undefined;
    setupStudioDashboard(window.document as unknown as Document, {
      fetch: async (input) => {
        if (String(input).includes('?sha=')) {
          await new Promise<void>((resolve) => {
            finishPoll = resolve;
          });
          return Response.json({
            deployment: { phase: 'building', provider: 'local', targetSha: 'a'.repeat(40) },
          });
        }
        return Response.json({
          deployment: { phase: 'ready', provider: 'local', targetSha: '0'.repeat(40) },
          health: {
            production: { status: 'healthy', detail: '生产可达' },
            worker: { status: 'healthy', detail: 'Worker 心跳正常' },
            scheduler: { status: 'healthy', detail: '定时发布正常' },
            backup: { status: 'healthy', detail: '离机备份正常' },
          },
        });
      },
      setTimeout: (() => 0) as unknown as typeof globalThis.setTimeout,
    });
    await settle();
    expect(element(window, '[data-platform-health-item="worker"]').dataset.status).toBe('healthy');
    finishPoll?.();
    await settle();
    expect(element(window, '[data-platform-health-item="worker"]').dataset.status).toBe('healthy');
    expect(
      element(window, '[data-platform-health-item="worker"] [data-health-detail]').textContent,
    ).toContain('心跳正常');
  });

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
