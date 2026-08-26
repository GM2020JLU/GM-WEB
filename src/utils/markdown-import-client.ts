import { parseMarkdownImport } from './markdown-import';
import { renderMarkdownPreview } from './markdown-preview';
import { generateStudioSlug } from './studio-slug';

type ImportResponse = {
  actionLabel?: string;
  actionUrl?: string;
  collection?: string;
  error?: string;
  loginUrl?: string;
  slug?: string;
};

export interface MarkdownImportClientOptions {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  isProduction?: boolean;
  navigate?: (url: string) => void;
  setTimeout?: typeof globalThis.setTimeout;
}

function requiredElement<T extends Element>(document: Document, selector: string) {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`导入界面初始化失败：缺少 ${selector}`);
  return element;
}

function readWithFileReader(file: File, document: Document) {
  const FileReaderClass = document.defaultView?.FileReader;
  if (!FileReaderClass) throw new Error('当前浏览器不支持读取本地文件，请升级浏览器后重试。');

  return new Promise<string>((resolve, reject) => {
    const reader = new FileReaderClass();
    reader.onerror = () => reject(new Error('浏览器读取文件失败，请重新选择。'));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsText(file, 'utf-8');
  });
}

export async function readMarkdownFile(file: File, document: Document) {
  if (typeof file.text === 'function') {
    try {
      return await file.text();
    } catch {
      // Safari/WKWebView 的 File.text() 偶尔会失败，继续使用兼容性更好的 FileReader。
    }
  }
  return readWithFileReader(file, document);
}

async function responsePayload(response: Response): Promise<ImportResponse> {
  try {
    return (await response.json()) as ImportResponse;
  } catch {
    return { error: `服务器返回了无法识别的响应（HTTP ${response.status}）。` };
  }
}

export function setupMarkdownImport(
  document: Document,
  {
    fetch: request = globalThis.fetch,
    navigate = (url) => document.defaultView?.location.assign(url),
    setTimeout: defer = globalThis.setTimeout,
  }: MarkdownImportClientOptions = {},
) {
  const form = requiredElement<HTMLFormElement>(document, '[data-import-form]');
  if (form.dataset.importReady === 'true') return;
  form.dataset.importReady = 'true';

  const fileInput = requiredElement<HTMLInputElement>(document, '[data-file]');
  const fileLabel = requiredElement<HTMLElement>(document, '[data-file-label]');
  const dropzone = requiredElement<HTMLElement>(document, '[data-dropzone]');
  const collection = requiredElement<HTMLSelectElement>(document, '[data-collection]');
  const title = requiredElement<HTMLInputElement>(document, '[data-title]');
  const slug = requiredElement<HTMLInputElement>(document, '[data-slug]');
  const description = requiredElement<HTMLTextAreaElement>(document, '[data-description]');
  const descriptionField = requiredElement<HTMLElement>(document, '[data-description-field]');
  const creator = requiredElement<HTMLInputElement>(document, '[data-creator]');
  const creatorField = requiredElement<HTMLElement>(document, '[data-creator-field]');
  const parseState = requiredElement<HTMLElement>(document, '[data-parse-state]');
  const emptyPreview = requiredElement<HTMLElement>(document, '[data-empty-preview]');
  const previewContent = requiredElement<HTMLElement>(document, '[data-preview-content]');
  const previewFile = requiredElement<HTMLElement>(document, '[data-preview-file]');
  const previewSize = requiredElement<HTMLElement>(document, '[data-preview-size]');
  const warnings = requiredElement<HTMLElement>(document, '[data-warnings]');
  const warningList = requiredElement<HTMLElement>(document, '[data-warning-list]');
  const bodyPreview = requiredElement<HTMLElement>(document, '[data-body-preview]');
  const submit = requiredElement<HTMLButtonElement>(document, '[data-submit]');
  const result = requiredElement<HTMLElement>(document, '[data-result]');
  let selectedSource = '';
  let selectedFilename = '';
  let loadSequence = 0;
  const requestedCollection = document.defaultView?.location.search
    ? new URLSearchParams(document.defaultView.location.search).get('collection')
    : null;
  if (requestedCollection && ['blog', 'projects', 'vibe', 'media'].includes(requestedCollection)) {
    collection.value = requestedCollection;
  }

  const setResult = (heading: string, detail: string, kind = '') => {
    result.className = `result ${kind}`.trim();
    result.replaceChildren();
    const strong = document.createElement('strong');
    const small = document.createElement('small');
    strong.textContent = heading;
    small.textContent = detail;
    result.append(strong, small);
  };

  const setBusy = (busy: boolean) => {
    form.setAttribute('aria-busy', String(busy));
    submit.disabled = busy || !selectedSource;
  };

  const updateTypeFields = () => {
    const isMedia = collection.value === 'media';
    creatorField.hidden = !isMedia;
    creator.required = isMedia;
    const needsDescription = collection.value === 'blog' || collection.value === 'projects';
    descriptionField.hidden = !needsDescription;
    description.required = needsDescription;
  };

  const loadFile = async (file: File) => {
    const sequence = ++loadSequence;
    selectedSource = '';
    selectedFilename = '';
    submit.disabled = true;
    parseState.textContent = '正在读取…';
    fileLabel.textContent = file.name;
    setResult('正在读取文件', '解析完成后会自动显示标题、摘要和正文。');

    try {
      const source = await readMarkdownFile(file, document);
      if (sequence !== loadSequence) return;
      const parsed = parseMarkdownImport(file.name, source);
      selectedSource = source;
      selectedFilename = file.name;
      title.value = parsed.title;
      slug.value = generateStudioSlug(parsed.title) || parsed.slug;
      description.value = parsed.description;
      creator.value = typeof parsed.data.creator === 'string' ? parsed.data.creator : '';
      parseState.textContent = '解析完成';
      emptyPreview.hidden = true;
      previewContent.hidden = false;
      previewFile.textContent = file.name;
      previewSize.textContent = `${parsed.body.length.toLocaleString('zh-CN')} 字符`;
      bodyPreview.innerHTML = parsed.body
        ? renderMarkdownPreview(parsed.body.slice(0, 12000))
        : '<p>（空正文）</p>';
      for (const link of bodyPreview.querySelectorAll('a')) {
        link.target = '_blank';
        link.rel = 'noopener noreferrer nofollow';
      }
      warningList.replaceChildren(
        ...parsed.warnings.map((message) => {
          const item = document.createElement('li');
          item.textContent = message;
          return item;
        }),
      );
      warnings.hidden = parsed.warnings.length === 0;
      submit.disabled = false;
      setResult('文件已解析，可以导入', '请确认内容类型、标题和正文。网址会自动生成。', 'success');
    } catch (error) {
      if (sequence !== loadSequence) return;
      selectedSource = '';
      selectedFilename = '';
      fileInput.value = '';
      submit.disabled = true;
      parseState.textContent = '解析失败';
      setResult(
        '无法读取文件',
        error instanceof Error ? error.message : '请更换 Markdown 文件。',
        'error',
      );
    }
  };

  const preventAndHighlight = (event: DragEvent) => {
    event.preventDefault();
    dropzone.classList.add('is-dragging');
  };
  dropzone.addEventListener('dragenter', preventAndHighlight);
  dropzone.addEventListener('dragover', preventAndHighlight);
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragging'));
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('is-dragging');
    const file = event.dataTransfer?.files?.[0];
    if (file) void loadFile(file);
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void loadFile(file);
  });
  collection.addEventListener('change', updateTypeFields);
  title.addEventListener('input', () => {
    slug.value = generateStudioSlug(title.value);
  });
  updateTypeFields();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!selectedSource) {
      setResult('还没有可导入的文件', '请先选择或拖入一个 .md 文件。', 'error');
      return;
    }
    if (!form.reportValidity()) {
      setResult('请补全必填字段', '检查标题、网址别名、摘要或创作者。', 'error');
      return;
    }

    setBusy(true);
    submit.textContent = '正在导入…';
    setResult('正在创建草稿', '将通过已登录的 Keystatic / GitHub 身份写入仓库。');
    try {
      const response = await request('/api/studio/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collection: collection.value,
          filename: selectedFilename,
          source: selectedSource,
          slug: slug.value,
          title: title.value,
          description: description.value,
          creator: creator.value,
        }),
      });
      const payload = await responsePayload(response);
      if (!response.ok) {
        if (response.status === 401) {
          setResult(
            '需要登录 Keystatic',
            '请先完成 GitHub 登录；本页内容会保留，登录后再点一次导入。',
            'error',
          );
          const link = document.createElement('a');
          link.href = payload.loginUrl || '/api/keystatic/github/login';
          link.target = '_blank';
          link.rel = 'noopener';
          link.textContent = '立即登录（新窗口）';
          result.append(link);
        } else {
          setResult('导入未完成', payload.error || '请检查字段后重试。', 'error');
          if (payload.actionUrl) {
            const link = document.createElement('a');
            link.href = payload.actionUrl;
            link.target = '_blank';
            link.rel = 'noopener';
            link.textContent = payload.actionLabel || '前往处理';
            result.append(link);
          }
        }
        return;
      }

      if (!payload.collection || !payload.slug) {
        throw new Error('服务器未返回草稿位置，请刷新后确认仓库内容。');
      }
      setResult('导入成功', '草稿已写入仓库，正在进入 Studio 编辑器…', 'success');
      const editorUrl = `/studio/edit/${encodeURIComponent(payload.collection)}/${encodeURIComponent(payload.slug)}`;
      defer(() => navigate(editorUrl), 700);
    } catch (error) {
      setResult('网络请求失败', error instanceof Error ? error.message : '请稍后重试。', 'error');
    } finally {
      setBusy(false);
      submit.textContent = '确认导入为草稿';
    }
  });

  return { loadFile };
}
