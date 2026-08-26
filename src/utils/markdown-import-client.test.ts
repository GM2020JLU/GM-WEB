import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { readMarkdownFile, setupMarkdownImport } from './markdown-import-client';
import { renderMarkdownPreview } from './markdown-preview';

const page = `
  <form data-import-form>
    <label data-dropzone><input type="file" data-file><strong data-file-label>选择文件</strong></label>
    <select data-collection><option value="blog">博客</option><option value="media">媒体</option></select>
    <input data-title required><input data-slug required pattern="[a-z0-9-]+">
    <textarea data-description></textarea>
    <label data-creator-field hidden><input data-creator></label>
    <span data-parse-state>等待文件</span>
    <div data-empty-preview></div><div data-preview-content hidden></div>
    <span data-preview-file></span><span data-preview-size></span>
    <div data-warnings hidden><ul data-warning-list></ul></div><pre data-body-preview></pre>
    <div data-result><strong>尚未导入</strong></div>
    <button data-submit type="submit" disabled>确认导入为草稿</button>
  </form>`;

function createPage() {
  const window = new Window({ url: 'https://goumin.work/studio/import' });
  window.document.body.innerHTML = page;
  return window;
}

function markdown(window: Window, name = 'hello-world.md') {
  return new window.File(
    [
      '---\ntitle: DOM 测试\ndescription: DOM 摘要\n---\n\n# 正文\n\n**加粗内容**与[链接](https://example.com)。',
    ],
    name,
    { type: 'text/markdown' },
  );
}

function browserDocument(window: Window) {
  return window.document as unknown as Document;
}

function element(window: Window, selector: string) {
  return window.document.querySelector(selector) as any;
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('Markdown 导入浏览器交互', () => {
  test('选择文件后立即解析并展示预览', async () => {
    const window = createPage();
    setupMarkdownImport(browserDocument(window), { fetch: async () => new Response() });
    const input = element(window, '[data-file]');
    const transfer = new window.DataTransfer();
    transfer.items.add(markdown(window));
    input.files = transfer.files;
    input.dispatchEvent(new window.Event('change'));
    await settle();

    expect(element(window, '[data-title]').value).toBe('DOM 测试');
    expect(element(window, '[data-parse-state]').textContent).toBe('解析完成');
    expect(element(window, '[data-preview-content]').hasAttribute('hidden')).toBe(false);
    expect(element(window, '[data-body-preview]').innerHTML).toContain('<h1>正文</h1>');
    expect(element(window, '[data-body-preview]').innerHTML).toContain('<strong>加粗内容</strong>');
    expect(element(window, '[data-submit]').disabled).toBe(false);
  });

  test('拖放文件与选择文件走相同解析流程', async () => {
    const window = createPage();
    setupMarkdownImport(browserDocument(window), { fetch: async () => new Response() });
    const transfer = new window.DataTransfer();
    transfer.items.add(markdown(window, 'dragged.md'));
    const dropzone = window.document.querySelector('[data-dropzone]')!;
    const dragover = new window.DragEvent('dragover');
    Object.defineProperty(dragover, 'dataTransfer', { value: transfer });
    dropzone.dispatchEvent(dragover);
    expect(dropzone.classList.contains('is-dragging')).toBe(true);
    const drop = new window.DragEvent('drop');
    Object.defineProperty(drop, 'dataTransfer', { value: transfer });
    dropzone.dispatchEvent(drop);
    await settle();

    expect(element(window, '[data-preview-file]').textContent).toBe('dragged.md');
    expect(dropzone.classList.contains('is-dragging')).toBe(false);
  });

  test('未登录提交时明确显示登录入口且保留已解析内容', async () => {
    const window = createPage();
    let requestBody = '';
    const client = setupMarkdownImport(browserDocument(window), {
      fetch: async (_url, init) => {
        requestBody = String(init?.body);
        return Response.json(
          { error: '请先登录', loginUrl: '/api/keystatic/github/login?from=branch/main' },
          { status: 401 },
        );
      },
    });
    await client?.loadFile(markdown(window) as unknown as File);
    element(window, '[data-import-form]').requestSubmit();
    await settle();

    expect(requestBody).toContain('hello-world.md');
    expect(element(window, '[data-result]').textContent).toContain('需要登录 Keystatic');
    expect(element(window, '[data-result] a').href).toContain('/api/keystatic/github/login');
    expect(element(window, '[data-submit]').disabled).toBe(false);
  });

  test('导入成功后进入 production 分支的编辑页面', async () => {
    const window = createPage();
    let destination = '';
    const client = setupMarkdownImport(browserDocument(window), {
      fetch: async () => Response.json({ collection: 'blog', slug: 'hello-world' }),
      isProduction: true,
      navigate: (url) => {
        destination = url;
      },
      setTimeout: ((callback: TimerHandler) => {
        if (typeof callback === 'function') callback();
        return 1;
      }) as typeof globalThis.setTimeout,
    });
    await client?.loadFile(markdown(window) as unknown as File);
    element(window, '[data-import-form]').requestSubmit();
    await settle();

    expect(destination).toBe('/keystatic/branch/main/collection/blog/item/hello-world');
    expect(element(window, '[data-result]').textContent).toContain('导入成功');
  });

  test('仓库权限不足时显示 GitHub App 配置入口', async () => {
    const window = createPage();
    const client = setupMarkdownImport(browserDocument(window), {
      fetch: async () =>
        Response.json(
          {
            error: 'Keystatic GitHub App 尚未安装到 GM-WEB。',
            actionLabel: '配置 GitHub App 仓库权限',
            actionUrl: 'https://github.com/apps/gm2020jlu-keystatic/installations/new',
          },
          { status: 403 },
        ),
    });
    await client?.loadFile(markdown(window) as unknown as File);
    element(window, '[data-import-form]').requestSubmit();
    await settle();

    expect(element(window, '[data-result]').textContent).toContain('尚未安装到 GM-WEB');
    expect(element(window, '[data-result] a').href).toContain(
      '/gm2020jlu-keystatic/installations/new',
    );
  });

  test('File.text 失败时使用 FileReader 兼容读取', async () => {
    const window = createPage();
    const file = markdown(window);
    Object.defineProperty(file, 'text', { value: async () => Promise.reject(new Error('fail')) });
    const content = await readMarkdownFile(file as unknown as File, browserDocument(window));
    expect(content).toContain('DOM 测试');
  });

  test('渲染 Markdown 并清理危险链接和标签', () => {
    const html = renderMarkdownPreview(
      '# 标题\n\n[危险链接](javascript:alert(1))\n\n<script>alert(1)</script>',
    );
    expect(html).toContain('<h1>标题</h1>');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<script>');
  });
});
