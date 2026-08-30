import { studioAssetReference } from './studio-assets';

export interface StudioAssetItem {
  name: string;
  path: string;
  sha?: string;
  size: number;
  url: string;
}

type StudioAssetsPayload = {
  assets?: StudioAssetItem[];
  error?: string;
  reference?: string;
  references?: string[];
};

export interface StudioAssetsOptions {
  confirm?: (message: string) => boolean;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  writeClipboard?: (value: string) => Promise<void>;
}

function required<T extends Element>(document: Document, selector: string) {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`素材库缺少必要控件：${selector}`);
  return value;
}

async function responsePayload(response: Response): Promise<StudioAssetsPayload> {
  try {
    return (await response.json()) as StudioAssetsPayload;
  } catch {
    return { error: `服务器响应异常（HTTP ${response.status}）。` };
  }
}

export function setupStudioAssets(document: Document, options: StudioAssetsOptions = {}) {
  const file = required<HTMLInputElement>(document, '[data-file]');
  const upload = required<HTMLElement>(document, '[data-upload]');
  const grid = required<HTMLElement>(document, '[data-assets]');
  const notice = required<HTMLElement>(document, '[data-notice]');
  const empty = required<HTMLElement>(document, '[data-empty]');
  const search = required<HTMLInputElement>(document, '[data-search]');
  const browserWindow = document.defaultView;
  if (!browserWindow) throw new Error('素材库需要浏览器环境。');
  const request = options.fetch ?? globalThis.fetch;
  const confirmAction =
    options.confirm ?? ((value: string) => browserWindow.confirm?.(value) ?? false);
  const writeClipboard =
    options.writeClipboard ??
    (async (value: string) => {
      if (!browserWindow.navigator.clipboard?.writeText) throw new Error('浏览器不支持剪贴板。');
      await browserWindow.navigator.clipboard.writeText(value);
    });
  let assets: StudioAssetItem[] = [];

  const message = (title: string, detail: string, kind = '') => {
    notice.className = `notice ${kind}`.trim();
    notice.innerHTML = '<strong></strong><small></small>';
    notice.querySelector('strong')!.textContent = title;
    notice.querySelector('small')!.textContent = detail;
    notice.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  };

  const render = () => {
    const query = search.value.trim().toLocaleLowerCase('zh-CN');
    const visible = assets.filter((asset) => asset.name.toLocaleLowerCase('zh-CN').includes(query));
    grid.replaceChildren(
      ...visible.map((asset) => {
        const reference = studioAssetReference(asset.path);
        const card = document.createElement('article');
        const image = document.createElement('img');
        const name = document.createElement('strong');
        const path = document.createElement('code');
        const meta = document.createElement('small');
        const actions = document.createElement('div');
        const copy = document.createElement('button');
        const remove = document.createElement('button');
        image.src = asset.url;
        image.alt = `${asset.name} 素材预览`;
        image.loading = 'lazy';
        name.textContent = asset.name;
        path.textContent = reference;
        path.title = reference;
        meta.textContent = asset.size
          ? `${Math.max(1, Math.round(asset.size / 1024)).toLocaleString('zh-CN')} KB`
          : '图片素材';
        copy.type = 'button';
        copy.textContent = '复制引用';
        copy.setAttribute('aria-label', `复制 ${asset.name} 的素材引用`);
        copy.addEventListener('click', async () => {
          try {
            await writeClipboard(reference);
            copy.textContent = '已复制';
            message('引用已复制', reference, 'success');
          } catch {
            message('无法复制引用', `请手动复制：${reference}`, 'error');
          }
        });
        remove.type = 'button';
        remove.textContent = '删除';
        remove.className = 'danger';
        remove.setAttribute('aria-label', `删除素材 ${asset.name}`);
        remove.addEventListener('click', async () => {
          if (!confirmAction(`确定从内容仓库删除素材“${asset.name}”吗？`)) return;
          const focusIndex = [...grid.querySelectorAll('article')].indexOf(card);
          card.setAttribute('aria-busy', 'true');
          copy.disabled = true;
          remove.disabled = true;
          message('正在检查素材', '确认没有内容仍在引用这张图片。');
          try {
            const response = await request('/api/studio/assets', {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: asset.path, sha: asset.sha }),
            });
            const result = await responsePayload(response);
            if (!response.ok) {
              const detail = result.references?.length
                ? `请先从这些内容中移除引用：${result.references.slice(0, 4).join('、')}${
                    result.references.length > 4 ? ` 等 ${result.references.length} 处` : ''
                  }`
                : result.error || '请稍后重试。';
              message(response.status === 409 ? '素材仍在使用' : '删除失败', detail, 'error');
              return;
            }
            const loaded = await load({ announce: false });
            if (!loaded) return;
            const remainingCards = [...grid.querySelectorAll<HTMLElement>('article')];
            const nextCard = remainingCards[Math.min(focusIndex, remainingCards.length - 1)];
            (nextCard?.querySelector<HTMLButtonElement>('button') ?? search).focus();
            message('素材已删除', `${asset.name} 已从素材库移除。`, 'success');
          } catch (error) {
            message('删除失败', error instanceof Error ? error.message : '网络连接异常。', 'error');
          } finally {
            card.removeAttribute('aria-busy');
            copy.disabled = false;
            remove.disabled = false;
          }
        });
        actions.append(copy, remove);
        card.append(image, name, path, meta, actions);
        return card;
      }),
    );
    empty.hidden = visible.length > 0;
    empty.textContent = assets.length ? '没有匹配的素材。' : '还没有素材，可以上传第一张图片。';
  };

  const load = async ({ announce = true } = {}) => {
    try {
      const response = await request('/api/studio/assets');
      const result = await responsePayload(response);
      if (!response.ok || !Array.isArray(result.assets)) {
        throw new Error(result.error || '请刷新重试。');
      }
      assets = result.assets;
      render();
      if (announce) message('素材已同步', `共 ${assets.length} 个文件。`, 'success');
      return true;
    } catch (error) {
      message('素材加载失败', error instanceof Error ? error.message : '网络连接异常。', 'error');
      return false;
    }
  };

  search.addEventListener('input', render);
  file.addEventListener('change', async () => {
    const selected = file.files?.[0];
    if (!selected) return;
    if (selected.size > 5 * 1024 * 1024) {
      file.value = '';
      message('图片过大', '单张图片不能超过 5 MB。', 'error');
      return;
    }
    const form = new browserWindow.FormData();
    form.append('file', selected);
    upload.setAttribute('aria-busy', 'true');
    file.disabled = true;
    message('正在上传', '正在验证图片并写入内容仓库。');
    try {
      const response = await request('/api/studio/assets', { method: 'POST', body: form });
      const result = await responsePayload(response);
      if (!response.ok) throw new Error(result.error || '请稍后重试。');
      await load({ announce: false });
      message('上传成功', `可在正文中使用 ${result.reference ?? '这张素材'}。`, 'success');
    } catch (error) {
      message('上传失败', error instanceof Error ? error.message : '网络连接异常。', 'error');
    } finally {
      file.disabled = false;
      file.value = '';
      upload.removeAttribute('aria-busy');
    }
  });

  void load();
  return { load, render };
}
