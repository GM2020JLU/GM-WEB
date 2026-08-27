import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { STUDIO_DEPLOYMENT_STORAGE_KEY } from './studio-deployment';
import { setupStudioEditor } from './studio-editor-client';

const page = `
  <form data-editor-form>
    <input data-title required><input data-slug><span data-slug-preview></span>
    <label data-for="blog,projects,about"><textarea data-description></textarea></label>
    <label data-for="blog,projects,vibe,about"><input data-date></label>
    <select data-publication-status><option value="draft">草稿</option><option value="ready">待发布</option><option value="published">已发布</option></select>
    <label data-for="media"><input data-creator></label>
    <label data-for="vibe,media"><select data-content-type><option value="text">文字</option></select></label>
    <label data-for="media"><select data-progress><option value="planned">计划</option></select></label>
    <label data-for="blog,projects,vibe,media,about"><input data-tags></label>
    <label data-for="blog,projects,about"><input data-categories></label>
    <label data-for="blog,projects,about"><input data-series></label>
    <label data-for="blog,projects,vibe,media,about"><input data-scheduled-at></label>
    <textarea data-extras>{}</textarea>
    <section data-body-panel><textarea data-body></textarea><article data-preview></article></section>
    <span data-word-count></span><span data-current-status></span>
    <button type="button" data-view="edit">编辑</button>
    <button type="button" data-action="draft">保存草稿</button>
    <button type="button" data-action="publish">发布</button>
  </form>
  <div data-notice><strong></strong><small></small></div>
  <section data-deployment-tracker hidden><strong data-deployment-title></strong><small data-deployment-detail></small><span data-deployment-progress></span><a data-deployment-link hidden></a></section>
  <button data-history></button><dialog data-history-dialog></dialog><div data-history-list></div>`;

function element(window: Window, selector: string) {
  return window.document.querySelector(selector) as any;
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('Studio 编辑与发布交互', () => {
  test('标题自动生成网址，并持续反馈直到网站上线', async () => {
    const window = new Window({ url: 'https://goumin.work/studio/edit/blog/new?new=1' });
    window.document.body.innerHTML = page;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const deferred: TimerHandler[] = [];
    let deploymentChecks = 0;
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes('/api/studio/deployment')) {
        deploymentChecks++;
        return Response.json({
          deployment: {
            phase: deploymentChecks === 1 ? 'building' : 'ready',
            targetSha: 'a'.repeat(40),
            runtimeSha: deploymentChecks === 1 ? 'old' : 'a'.repeat(40),
          },
        });
      }
      if (init?.method === 'PUT') {
        return Response.json({
          ok: true,
          slug: 'ce-shi-wen-zhang',
          status: 'published',
          commitSha: 'a'.repeat(40),
          publicUrl: '/blog/ce-shi-wen-zhang',
          deploymentPending: true,
        });
      }
      return Response.json({
        document: {
          body: '# 正文',
          slug: 'new',
          metadata: {
            title: '',
            description: '',
            date: '2026-08-26T09:00:00+08:00',
            publicationStatus: 'draft',
          },
        },
      });
    };

    setupStudioEditor(window.document as unknown as Document, {
      collection: 'blog',
      initialSlug: 'new',
      isNew: true,
      fetch: fetch as typeof globalThis.fetch,
      pollDelay: 1,
      setTimeout: ((callback: TimerHandler) => {
        deferred.push(callback);
        return 1;
      }) as typeof globalThis.setTimeout,
    });
    await settle();

    element(window, '[data-title]').value = '测试文章';
    element(window, '[data-title]').dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(element(window, '[data-slug]').value).toMatch(/^ce-shi-wen-zhang/);
    expect(element(window, '[data-slug-preview]').textContent).toMatch(/^ce-shi-wen-zhang/);
    const recovery = deferred.shift();
    if (typeof recovery === 'function') recovery();
    expect(window.localStorage.getItem('gm-studio-recovery:blog:new')).toContain('测试文章');

    element(window, '[data-action="publish"]').click();
    await settle();
    expect(element(window, '[data-notice]').textContent).toContain('发布已提交');
    expect(element(window, '[data-deployment-title]').textContent).toBe('正在构建网站');
    expect(element(window, '[data-deployment-tracker]').hidden).toBe(false);
    expect(window.localStorage.getItem(STUDIO_DEPLOYMENT_STORAGE_KEY)).toContain('a'.repeat(40));

    const retry = deferred.shift();
    if (typeof retry === 'function') retry();
    await settle();
    expect(element(window, '[data-deployment-title]').textContent).toBe('网站已上线');
    expect(element(window, '[data-notice]').textContent).toContain('发布完成');
    expect(element(window, '[data-current-status]').textContent).toBe('已发布');
    expect(element(window, '[data-deployment-link]').hidden).toBe(false);
    expect(window.localStorage.getItem(STUDIO_DEPLOYMENT_STORAGE_KEY)).toBeNull();

    const write = requests.find((request) => request.init?.method === 'PUT');
    expect(JSON.parse(String(write?.init?.body)).slug).toMatch(/^ce-shi-wen-zhang/);
  });
});
