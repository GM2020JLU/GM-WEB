import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { STUDIO_DEPLOYMENT_STORAGE_KEY } from './studio-deployment';
import { diffStudioLines, setupStudioEditor } from './studio-editor-client';

const page = `
  <form data-editor-form>
    <input data-title required><input data-slug><span data-slug-preview></span>
    <label data-for="blog,projects,about"><textarea data-description></textarea></label>
    <label data-for="blog,projects,vibe,about"><input data-date></label>
    <select data-publication-status><option value="draft">草稿</option><option value="ready">待发布</option><option value="published">已发布</option></select>
    <label data-for="media"><input data-creator></label>
    <label data-for="vibe,media"><select data-content-type><option value="text">文字</option></select></label>
    <label data-for="media"><select data-progress><option value="planned">计划</option></select></label>
    <label data-for="blog,projects,vibe,media,about"><input data-tags><span data-taxonomy-suggestions="tags"></span></label>
    <label data-for="blog,projects,about"><input data-categories><span data-taxonomy-suggestions="categories"></span></label>
    <label data-for="blog,projects,about"><input data-series><span data-taxonomy-suggestions="series"></span></label>
    <datalist data-taxonomy-list="tags"></datalist><datalist data-taxonomy-list="categories"></datalist><datalist data-taxonomy-list="series"></datalist>
    <label data-for="blog,projects,vibe,media,about"><input data-scheduled-at></label>
    <textarea data-extras>{}</textarea>
    <section data-body-panel><textarea data-body></textarea><article data-preview></article></section>
    <span data-word-count></span><span data-preview-version></span><span data-current-status></span>
    <div class="view-switch"><button type="button" data-view="edit">编辑</button></div>
    <aside data-view="unrelated"></aside>
    <button type="button" data-action="save" data-save-label>保存更改</button>
    <button type="button" data-action="publish">发布</button>
  </form>
  <div data-notice><strong></strong><small></small></div>
  <section data-deployment-tracker hidden><strong data-deployment-title></strong><small data-deployment-detail></small><span data-deployment-progress></span><a data-deployment-link hidden></a></section>
  <button data-history></button><button data-delete></button><button data-open-asset-picker></button>
  <dialog data-history-dialog></dialog><div data-history-list></div><section data-history-diff hidden></section>
  <dialog data-asset-dialog><input data-asset-alt><input data-asset-search><input type="file" data-asset-upload><p data-asset-notice></p><div data-asset-picker-grid></div></dialog>`;

function element(window: Window, selector: string) {
  return window.document.querySelector(selector) as any;
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('Studio 编辑与发布交互', () => {
  test('行级差异区分新增、删除和未变内容', () => {
    expect(diffStudioLines('alpha\nbeta', 'alpha\ngamma')).toEqual([
      { kind: 'same', value: 'alpha' },
      { kind: 'added', value: 'gamma' },
      { kind: 'removed', value: 'beta' },
    ]);
  });

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
      fetch: fetch as unknown as typeof globalThis.fetch,
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
    element(window, '[data-action="save"]').click();
    await settle();
    element(window, '[data-body]').value = '# 第二次修改';
    element(window, '[data-action="save"]').click();
    await settle();

    expect(writes).toHaveLength(2);
    expect(writes[0].expectedSha).toBe('a'.repeat(40));
    expect(writes[1].expectedSha).toBe('b'.repeat(40));
  });

  test('已发布内容的快捷保存保持发布状态，过期恢复稿使用最新 SHA', async () => {
    const window = new Window({ url: 'https://goumin.work/studio/edit/blog/existing' });
    window.document.body.innerHTML = page;
    Object.defineProperty(window, 'confirm', { value: () => true });
    window.localStorage.setItem(
      'gm-studio-recovery:blog:existing',
      JSON.stringify({
        expectedSha: 'a'.repeat(40),
        values: { body: '# 本地编辑', status: 'draft', title: '已发布文章' },
        version: 2,
      }),
    );
    let submitted: Record<string, any> | undefined;
    const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        submitted = JSON.parse(String(init.body));
        return Response.json({
          ok: true,
          slug: 'existing',
          sha: 'c'.repeat(40),
          status: 'published',
          deploymentPending: false,
        });
      }
      return Response.json({
        document: {
          body: '# 服务器新版',
          sha: 'b'.repeat(40),
          slug: 'existing',
          metadata: {
            title: '已发布文章',
            description: '这是一段满足发布要求的文章摘要。',
            date: '2026-08-26T09:00:00+08:00',
            publicationStatus: 'published',
            draft: false,
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

    expect(element(window, '[data-body]').value).toBe('# 本地编辑');
    expect(element(window, '[data-current-status]').textContent).toBe('已发布');
    window.document.dispatchEvent(
      new window.KeyboardEvent('keydown', { ctrlKey: true, key: 's', bubbles: true }),
    );
    await settle();

    expect(submitted?.action).toBe('save');
    expect(submitted?.expectedSha).toBe('b'.repeat(40));
    expect(submitted?.metadata.publicationStatus).toBe('published');
    expect(submitted?.metadata.draft).toBe(false);
  });

  test('legacy 恢复稿中仅摘要、日期、标签或高级字段变化也会提示并完整恢复', async () => {
    const cases = [
      { key: 'description', value: '恢复稿中的新摘要' },
      { key: 'date', value: '2026-08-29T14:30:00+08:00' },
      { key: 'tags', value: ['Astro', 'Studio'] },
      { key: 'legacyOnly', value: { enabled: true } },
    ] as const;
    for (const changed of cases) {
      const window = new Window({ url: 'https://goumin.work/studio/edit/blog/existing' });
      window.document.body.innerHTML = page;
      let confirmations = 0;
      Object.defineProperty(window, 'confirm', {
        value: () => {
          confirmations++;
          return true;
        },
      });
      const serverMetadata: Record<string, unknown> = {
        title: '原文',
        description: '服务器摘要',
        date: '2026-08-26T09:00:00+08:00',
        publicationStatus: 'draft',
        draft: true,
        tags: ['Astro'],
        legacyOnly: { enabled: false },
      };
      const legacyMetadata = { ...serverMetadata, [changed.key]: changed.value };
      window.localStorage.setItem(
        'gm-studio-recovery:blog:existing',
        JSON.stringify({
          body: '# 正文',
          expectedSha: 'a'.repeat(40),
          metadata: legacyMetadata,
          slug: 'existing',
        }),
      );
      setupStudioEditor(window.document as unknown as Document, {
        collection: 'blog',
        initialSlug: 'existing',
        isNew: false,
        fetch: (async () =>
          Response.json({
            document: {
              body: '# 正文',
              sha: 'a'.repeat(40),
              slug: 'existing',
              metadata: serverMetadata,
            },
          })) as unknown as typeof globalThis.fetch,
      });
      await settle();

      expect(confirmations).toBe(1);
      if (changed.key === 'description') {
        expect(element(window, '[data-description]').value).toBe(changed.value);
      } else if (changed.key === 'date') {
        expect(element(window, '[data-date]').value).toBe('2026-08-29T14:30');
      } else if (changed.key === 'tags') {
        expect(element(window, '[data-tags]').value).toBe('Astro，Studio');
      } else {
        expect(JSON.parse(element(window, '[data-extras]').value).legacyOnly).toEqual(
          changed.value,
        );
      }
    }
  });

  test('过期 legacy 恢复稿迁移后使用最新 SHA 且保持服务器发布状态', async () => {
    const window = new Window({ url: 'https://goumin.work/studio/edit/blog/existing' });
    window.document.body.innerHTML = page;
    Object.defineProperty(window, 'confirm', { value: () => true });
    window.localStorage.setItem(
      'gm-studio-recovery:blog:existing',
      JSON.stringify({
        body: '# legacy 本地修改',
        expectedSha: 'a'.repeat(40),
        metadata: {
          title: '已发布文章',
          description: '这是一段满足发布要求的文章摘要。',
          date: '2026-08-26T09:00:00+08:00',
          publicationStatus: 'draft',
          draft: true,
          tags: [],
        },
        slug: 'existing',
      }),
    );
    let submitted: Record<string, any> | undefined;
    const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        submitted = JSON.parse(String(init.body));
        return Response.json({
          slug: 'existing',
          sha: 'c'.repeat(40),
          status: 'published',
          deploymentPending: false,
        });
      }
      return Response.json({
        document: {
          body: '# 服务器新版',
          sha: 'b'.repeat(40),
          slug: 'existing',
          metadata: {
            title: '已发布文章',
            description: '这是一段满足发布要求的文章摘要。',
            date: '2026-08-26T09:00:00+08:00',
            publicationStatus: 'published',
            draft: false,
            tags: [],
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

    expect(element(window, '[data-body]').value).toBe('# legacy 本地修改');
    expect(element(window, '[data-current-status]').textContent).toBe('已发布');
    element(window, '[data-action="save"]').click();
    await settle();
    expect(submitted?.expectedSha).toBe('b'.repeat(40));
    expect(submitted?.metadata.publicationStatus).toBe('published');
  });

  test('加载失败时不展示空编辑表单，可原地重试', async () => {
    const window = new Window({ url: 'https://goumin.work/studio/edit/blog/existing' });
    window.document.body.innerHTML = page;
    let attempts = 0;
    const fetch = async () => {
      attempts++;
      if (attempts === 1) return Response.json({ error: '临时无法读取' }, { status: 503 });
      return Response.json({
        document: {
          body: '# 正文',
          sha: 'a'.repeat(40),
          slug: 'existing',
          metadata: { title: '已恢复', publicationStatus: 'draft' },
        },
      });
    };

    setupStudioEditor(window.document as unknown as Document, {
      collection: 'blog',
      initialSlug: 'existing',
      isNew: false,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await settle();
    expect(element(window, '[data-editor-form]').hidden).toBe(true);
    expect(element(window, '[data-notice] button').textContent).toBe('重新读取');

    element(window, '[data-notice] button').click();
    await settle();
    expect(element(window, '[data-editor-form]').hidden).toBe(false);
    expect(element(window, '[data-title]').value).toBe('已恢复');
  });

  test('各内容类型的高级字段经过结构化编辑器后仍原样保留', async () => {
    const cases = [
      {
        collection: 'projects',
        advanced: {
          authors: [{ name: 'GM', url: 'https://goumin.work' }],
          links: [{ label: 'GitHub', url: 'https://github.com/GM2020JLU' }],
        },
      },
      {
        collection: 'vibe',
        advanced: { images: ['@assets/images/content/vibe.png'] },
      },
      {
        collection: 'media',
        advanced: {
          cover: '@assets/images/content/book.png',
          externalUrl: 'https://example.com/book',
        },
      },
    ];

    for (const current of cases) {
      const window = new Window({
        url: `https://goumin.work/studio/edit/${current.collection}/existing`,
      });
      window.document.body.innerHTML = page;
      let submitted: Record<string, any> | undefined;
      const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          submitted = JSON.parse(String(init.body));
          return Response.json({
            ok: true,
            slug: 'existing',
            sha: 'b'.repeat(40),
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
              ...current.advanced,
              title: '高级字段测试',
              publicationStatus: 'draft',
              draft: true,
            },
          },
        });
      };
      setupStudioEditor(window.document as unknown as Document, {
        collection: current.collection,
        initialSlug: 'existing',
        isNew: false,
        fetch: fetch as typeof globalThis.fetch,
      });
      await settle();
      element(window, '[data-action="save"]').click();
      await settle();

      for (const [key, value] of Object.entries(current.advanced)) {
        expect(submitted?.metadata[key]).toEqual(value);
      }
    }
  });

  test('可点选已有分类并从素材库插入带 alt 的 Markdown', async () => {
    const window = new Window({ url: 'https://goumin.work/studio/edit/blog/existing' });
    window.document.body.innerHTML = page;
    const fetch = async (input: RequestInfo | URL) => {
      if (String(input) === '/api/studio/assets') {
        return Response.json({
          assets: [
            {
              name: 'cover.png',
              path: 'src/assets/images/content/cover.png',
              size: 1024,
              url: 'https://example.com/cover.png',
            },
          ],
        });
      }
      return Response.json({
        document: {
          body: '# 正文',
          sha: 'a'.repeat(40),
          slug: 'existing',
          metadata: { title: '文章', publicationStatus: 'draft' },
        },
        taxonomies: {
          categories: ['站点日志'],
          series: ['Astro 实战'],
          tags: ['Astro'],
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

    expect(element(window, '[data-taxonomy-list="tags"] option').value).toBe('Astro');
    element(window, '[data-taxonomy-suggestions="tags"] button').click();
    expect(element(window, '[data-tags]').value).toBe('Astro');

    element(window, '[data-open-asset-picker]').click();
    await settle();
    element(window, '[data-asset-alt]').value = '站点封面';
    element(window, '[data-asset-picker-grid] button').click();
    expect(element(window, '[data-body]').value).toContain(
      '![站点封面](@assets/images/content/cover.png)',
    );
    expect(element(window, '[data-preview-version]').textContent).toContain('未保存版本');
  });

  test('封面、阅读侧栏和评论配置通过结构化控件往返', async () => {
    const window = new Window({ url: 'https://goumin.work/studio/edit/blog/existing' });
    window.document.body.innerHTML = page;
    element(window, '[data-editor-form]').insertAdjacentHTML(
      'beforeend',
      `<label data-for="blog,projects,about"><input data-hero-image></label>
       <label data-for="blog,projects,about"><input data-hero-image-alt></label>
       <div data-for="blog,projects,about">
         <input type="checkbox" data-show-hero-image><input type="checkbox" data-comments>
         <input type="checkbox" data-sidebar-enable><input type="checkbox" data-sidebar-toc>
         <input type="checkbox" data-sidebar-related>
       </div>`,
    );
    let submitted: Record<string, any> | undefined;
    const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        submitted = JSON.parse(String(init.body));
        return Response.json({
          ok: true,
          slug: 'existing',
          sha: 'b'.repeat(40),
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
            title: '结构化字段',
            publicationStatus: 'draft',
            heroImage: '@assets/images/content/hero.png',
            heroImageAlt: '一台小型计算机',
            showHeroImage: false,
            comments: false,
            sidebar: { enable: true, toc: false, relatedPosts: true },
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

    expect(element(window, '[data-hero-image]').value).toBe('@assets/images/content/hero.png');
    expect(element(window, '[data-show-hero-image]').checked).toBe(false);
    expect(element(window, '[data-sidebar-toc]').checked).toBe(false);
    element(window, '[data-action="save"]').click();
    await settle();

    expect(submitted?.metadata).toMatchObject({
      heroImage: '@assets/images/content/hero.png',
      heroImageAlt: '一台小型计算机',
      showHeroImage: false,
      comments: false,
      sidebar: { enable: true, toc: false, relatedPosts: true },
    });
  });

  test('版本历史可预览与当前未保存内容的行级差异', async () => {
    const window = new Window({ url: 'https://goumin.work/studio/edit/blog/existing' });
    window.document.body.innerHTML = page;
    const revision = 'd'.repeat(40);
    const fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/studio/history') && url.includes('?ref=')) {
        return Response.json({
          document: { body: '# 历史标题\n\n旧段落', metadata: {}, slug: 'existing' },
        });
      }
      if (url.includes('/api/studio/history')) {
        return Response.json({
          history: [
            {
              author: 'GM',
              date: '2026-08-30T10:00:00+08:00',
              message: 'Update article',
              sha: revision,
            },
          ],
        });
      }
      return Response.json({
        document: {
          body: '# 当前标题\n\n新段落',
          sha: 'a'.repeat(40),
          slug: 'existing',
          metadata: { title: '文章', publicationStatus: 'draft' },
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

    element(window, '[data-history]').click();
    await settle();
    element(window, '[data-history-list] button').click();
    await settle();

    expect(element(window, '[data-history-diff]').hidden).toBe(false);
    expect(element(window, '[data-history-diff]').textContent).toContain(revision.slice(0, 7));
    expect(window.document.querySelector('[data-history-diff] .diff-added')).not.toBeNull();
    expect(window.document.querySelector('[data-history-diff] .diff-removed')).not.toBeNull();
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
    element(window, '[data-action="save"]').click();
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

    element(window, '[data-action="save"]').click();
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
