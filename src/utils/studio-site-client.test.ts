import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { STUDIO_DEPLOYMENT_STORAGE_KEY } from './studio-deployment';
import { setupStudioSite } from './studio-site-client';

const names = [
  'site.title',
  'site.description',
  'site.pageTitle',
  'site.pageDescription',
  'site.footerNote',
  'theme.palette',
  'profile.name',
  'profile.role',
  'profile.email',
  'profile.avatar',
  'home.introTitle',
  'home.introName',
  'home.introBody',
  'home.focus',
  'home.quote',
  ...['blog', 'projects', 'vibe', 'media'].flatMap((key) => [
    `pages.${key}.title`,
    `pages.${key}.subtitle`,
    `pages.${key}.note`,
  ]),
];

const markup = `
  <div data-notice></div>
  <form data-site-form>${names
    .map((name) =>
      name === 'theme.palette'
        ? `<select name="${name}"><option value="blue-soft">蓝 · 柔和</option></select>`
        : `<input name="${name}" required>`,
    )
    .join('')}<span data-save-state></span><button type="submit">保存</button></form>
  <img data-avatar-preview><span data-palette-preview></span>`;

const settings = {
  site: {
    title: '个人站',
    description: '说明',
    pageTitle: '首页',
    pageDescription: '首页说明',
    footerNote: '页脚',
  },
  theme: { palette: 'blue-soft' },
  profile: {
    name: '狗民',
    role: '开发者',
    email: 'me@example.com',
    avatar: 'https://example.com/a.png',
  },
  home: { introTitle: '你好', introName: '狗民', introBody: '正文', focus: '网站', quote: '引语' },
  pages: Object.fromEntries(
    ['blog', 'projects', 'vibe', 'media'].map((key) => [
      key,
      { title: key, subtitle: `${key} 副标题`, note: `${key} 说明` },
    ]),
  ),
};

function element(window: Window, selector: string) {
  return window.document.querySelector(selector) as any;
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('Studio 站点设置交互', () => {
  test('加载版本、保存完整设置并记录部署', async () => {
    const window = new Window({ url: 'https://goumin.work/studio/site' });
    window.document.body.innerHTML = markup;
    const writes: Array<Record<string, any>> = [];
    setupStudioSite(window.document as unknown as Document, {
      fetch: async (_input, init) => {
        if (init?.method === 'PUT') {
          writes.push(JSON.parse(String(init.body)));
          return Response.json({
            ok: true,
            sha: 'b'.repeat(40),
            commitSha: 'c'.repeat(40),
            deploymentPending: true,
          });
        }
        return Response.json({ settings, sha: 'a'.repeat(40) });
      },
    });
    await settle();
    expect(element(window, '[name="site.title"]').value).toBe('个人站');

    element(window, '[name="site.title"]').value = '新站名';
    element(window, '[name="site.title"]').dispatchEvent(
      new window.Event('input', { bubbles: true }),
    );
    element(window, 'form').dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true }),
    );
    await settle();
    expect(writes[0].expectedSha).toBe('a'.repeat(40));
    expect(writes[0].site.title).toBe('新站名');
    expect(window.localStorage.getItem(STUDIO_DEPLOYMENT_STORAGE_KEY)).toContain('c'.repeat(40));
    expect(element(window, '[data-notice]').textContent).toContain('保存成功');
  });

  test('恢复同版本本地修改并保持未保存状态', async () => {
    const window = new Window({ url: 'https://goumin.work/studio/site' });
    window.document.body.innerHTML = markup;
    const recovered = structuredClone(settings) as typeof settings;
    recovered.site.title = '本地未保存站名';
    window.localStorage.setItem(
      'gm-studio-site-recovery',
      JSON.stringify({ savedAt: new Date().toISOString(), sha: 'a'.repeat(40), values: recovered }),
    );
    setupStudioSite(window.document as unknown as Document, {
      confirm: () => true,
      fetch: async () => Response.json({ settings, sha: 'a'.repeat(40) }),
    });
    await settle();

    expect(element(window, '[name="site.title"]').value).toBe('本地未保存站名');
    expect(element(window, '[data-save-state]').textContent).toContain('未保存');
    expect(element(window, '[data-notice]').textContent).toContain('已恢复');
  });

  test('网络失败后重新启用保存按钮并保留恢复副本', async () => {
    const window = new Window({ url: 'https://goumin.work/studio/site' });
    window.document.body.innerHTML = markup;
    setupStudioSite(window.document as unknown as Document, {
      fetch: async (_input, init) => {
        if (init?.method === 'PUT') throw new Error('网络已断开');
        return Response.json({ settings, sha: 'a'.repeat(40) });
      },
    });
    await settle();
    element(window, '[name="site.title"]').value = '离线修改';
    element(window, '[name="site.title"]').dispatchEvent(
      new window.Event('input', { bubbles: true }),
    );
    element(window, 'form').dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true }),
    );
    await settle();

    expect(element(window, 'button[type="submit"]').disabled).toBe(false);
    expect(element(window, '[data-notice]').textContent).toContain('网络已断开');
    expect(window.localStorage.getItem('gm-studio-site-recovery')).toContain('离线修改');
  });

  test('服务器版本已变更时保留旧副本并由用户手动恢复', async () => {
    const window = new Window({ url: 'https://goumin.work/studio/site' });
    window.document.body.innerHTML = markup;
    const recovered = structuredClone(settings) as typeof settings;
    recovered.site.title = '旧的本地修改';
    window.localStorage.setItem(
      'gm-studio-site-recovery',
      JSON.stringify({ savedAt: new Date().toISOString(), sha: '9'.repeat(40), values: recovered }),
    );
    setupStudioSite(window.document as unknown as Document, {
      confirm: () => true,
      fetch: async () => Response.json({ settings, sha: 'a'.repeat(40) }),
    });
    await settle();

    expect(element(window, '[name="site.title"]').value).toBe('个人站');
    expect(element(window, '[data-notice]').textContent).toContain('仍保留');
    window.dispatchEvent(new window.Event('pagehide'));
    expect(window.localStorage.getItem('gm-studio-site-recovery')).toContain('旧的本地修改');

    const restore = [...window.document.querySelectorAll('[data-notice] button')].find(
      (button: any) => button.textContent === '恢复旧修改',
    ) as any;
    restore?.click();
    expect(element(window, '[name="site.title"]').value).toBe('旧的本地修改');
    expect(element(window, '[data-save-state]').textContent).toContain('未保存');
    expect(JSON.parse(window.localStorage.getItem('gm-studio-site-recovery') ?? '{}').sha).toBe(
      'a'.repeat(40),
    );
  });
});
