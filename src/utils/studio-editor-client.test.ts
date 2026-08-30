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
    <div class="view-switch"><button type="button" data-view="edit">编辑</button></div>
    <aside data-view="unrelated"></aside>
    <button type="button" data-action="draft">保存草稿</button>
    <button type="button" data-action="publish">发布</button>
  </form>
  <div data-notice><strong></strong><small></small></div>
  <section data-deployment-tracker hidden><strong data-deployment-title></strong><small data-deployment-detail></small><span data-deployment-progress></span><a data-deployment-link hidden></a></section>
  <button data-history></button><button data-delete></button><dialog data-history-dialog></dialog><div data-history-list></div>`;

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
          sha: 'b'.repeat(64),
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
    const writePayload = JSON.parse(String(write?.init?.body));
    expect(writePayload.slug).toMatch(/^ce-shi-wen-zhang/);
    expect(writePayload.expectedSha).toBeUndefined();

    element(window, '[data-body]').value = '# 继续编辑';
    element(window, '[data-body]').dispatchEvent(new window.Event('input', { bubbles: true }));
    const canonicalRecovery = deferred.shift();
    if (typeof canonicalRecovery === 'function') canonicalRecovery();
    expect(window.localStorage.getItem('gm-studio-recovery:blog:new')).toBeNull();
    expect(window.localStorage.getItem('gm-studio-recovery:blog:ce-shi-wen-zhang')).toContain(
      '继续编辑',
    );
    element(window, '.view-switch [data-view]').click();
    expect(element(window, '[data-body-panel]').dataset.editorView).toBe('edit');
    expect(element(window, '[data-view="unrelated"]').getAttribute('aria-pressed')).toBeNull();
  });

  test('现有内容每次保存都携带并更新 expectedSha', async () => {
    const window = new Window({ url: 'https://goumin.work/studio/edit/blog/existing' });
    window.document.body.innerHTML = page;
    const writes: Array<Record<string, unknown>> = [];
    let revision = 'a'.repeat(40);
    const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        writes.push(JSON.parse(String(init.body)));
        revision = revision.startsWith('a') ? 'b'.repeat(40) : 'c'.repeat(40);
        return Response.json({
          ok: true,
          slug: 'existing',
          sha: revision,
          status: 'draft',
          deploymentPending: false,
        });
      }
      return Response.json({
        document: {
          body: '# 正文',
          sha: 'a'.repeat(40),
          slug: 'existing',
          metadata: {
            title: '已有文章',
            description: '这是一段已有文章的完整内容摘要。',
            date: '2026-08-26T09:00:00+08:00',
            publicationStatus: 'draft',
          },
        },
      });
    };

    setupStudioEditor(window.document as unknown as Document, {
      collection: 'blog',
      initialSlug: 'existing',
      isNew: false,
      fetch: fetch as typeof globalThis.fetch,
    });
    await settle();

    element(window, '[data-body]').value = '# 第一次修改';
    element(window, '[data-action="draft"]').click();
    await settle();
    element(window, '[data-body]').value = '# 第二次修改';
    element(window, '[data-action="draft"]').click();
    await settle();

    expect(writes).toHaveLength(2);
    expect(writes[0].expectedSha).toBe('a'.repeat(40));
    expect(writes[1].expectedSha).toBe('b'.repeat(40));
  });

  test('新建内容写入成功但响应中断时确认原文件，不会重试生成副本', async () => {
    const window = new Window({ url: 'https://goumin.work/studio/edit/blog/new?new=1' });
    window.document.body.innerHTML = page;
    let created = false;
    let createRequests = 0;
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'PUT') {
        createRequests++;
        created = true;
        throw new Error('响应连接中断');
      }
      if (url.endsWith('/ce-shi-wen-zhang') && created) {
        return Response.json({
          document: {
            body: '# 正文',
            sha: 'd'.repeat(40),
            slug: 'ce-shi-wen-zhang',
            metadata: {
              title: '测试文章',
              date: '2026-08-26T09:00:00+08:00',
              tags: [],
              categories: [],
              series: [],
              publicationStatus: 'draft',
              draft: true,
            },
          },
        });
      }
      return Response.json({
        document: {
          body: '',
          slug: 'new',
          metadata: { title: '', publicationStatus: 'draft', draft: true },
        },
      });
    };

    setupStudioEditor(window.document as unknown as Document, {
      collection: 'blog',
      initialSlug: 'new',
      isNew: true,
      fetch: fetch as typeof globalThis.fetch,
    });
    await settle();
    element(window, '[data-title]').value = '测试文章';
    element(window, '[data-title]').dispatchEvent(new window.Event('input', { bubbles: true }));
    element(window, '[data-body]').value = '# 正文';
    element(window, '[data-action="draft"]').click();
    await settle();

    expect(createRequests).toBe(1);
    expect(element(window, '[data-notice]').textContent).toContain('内容已经保存');
    expect(window.location.pathname).toBe('/studio/edit/blog/ce-shi-wen-zhang');
    expect(element(window, '[data-slug]').value).toBe('ce-shi-wen-zhang');
  });

  test('高级 JSON 暂时无效时保留完整恢复副本且不锁死表单', async () => {
    const window = new Window({ url: 'https://goumin.work/studio/edit/blog/existing' });
    window.document.body.innerHTML = page;
    const deferred: TimerHandler[] = [];
    let writes = 0;
    const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        writes++;
        return Response.json({ ok: true });
      }
      return Response.json({
        document: {
          body: '# 原正文',
          sha: 'a'.repeat(40),
          slug: 'existing',
          metadata: {
            title: '已有文章',
            description: '这是一段已有文章的完整内容摘要。',
            date: '2026-08-26T09:00:00+08:00',
            publicationStatus: 'draft',
          },
        },
      });
    };

    setupStudioEditor(window.document as unknown as Document, {
      collection: 'blog',
      initialSlug: 'existing',
      isNew: false,
      fetch: fetch as typeof globalThis.fetch,
      setTimeout: ((callback: TimerHandler) => {
        deferred.push(callback);
        return 1;
      }) as typeof globalThis.setTimeout,
    });
    await settle();

    element(window, '[data-body]').value = '# 未保存正文';
    element(window, '[data-body]').dispatchEvent(new window.Event('input', { bubbles: true }));
    element(window, '[data-extras]').value = '{';
    element(window, '[data-extras]').dispatchEvent(new window.Event('input', { bubbles: true }));
    deferred.forEach((callback) => typeof callback === 'function' && callback());
    window.dispatchEvent(new window.Event('pagehide'));

    const recovered = window.localStorage.getItem('gm-studio-recovery:blog:existing');
    expect(recovered).toContain('未保存正文');
    expect(recovered).toContain('"extras":"{"');

    element(window, '[data-action="draft"]').click();
    await settle();
    expect(writes).toBe(0);
    expect(element(window, '[data-editor-form]').inert).toBe(false);
    expect(element(window, '[data-notice]').textContent).toContain('无法保存');
    expect(element(window, '[data-notice]').getAttribute('role')).toBe('alert');
  });

  test('删除携带当前内容版本，过期页面不会删除新版本', async () => {
    const window = new Window({ url: 'https://goumin.work/studio/edit/blog/existing' });
    window.document.body.innerHTML = page;
    Object.defineProperty(window, 'confirm', { value: () => true });
    let deletePayload: Record<string, unknown> | undefined;
    const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deletePayload = JSON.parse(String(init.body));
        return Response.json({ error: '内容已被修改。' }, { status: 409 });
      }
      return Response.json({
        document: {
          body: '# 正文',
          sha: 'a'.repeat(40),
          slug: 'existing',
          metadata: {
            title: '已有文章',
            description: '这是一段已有文章的完整内容摘要。',
            date: '2026-08-26T09:00:00+08:00',
            publicationStatus: 'draft',
          },
        },
      });
    };

    setupStudioEditor(window.document as unknown as Document, {
      collection: 'blog',
      initialSlug: 'existing',
      isNew: false,
      fetch: fetch as typeof globalThis.fetch,
    });
    await settle();
    element(window, '[data-delete]').click();
    await settle();

    expect(deletePayload).toEqual({ expectedSha: 'a'.repeat(40) });
    expect(element(window, '[data-notice]').textContent).toContain('删除失败');
  });
});
