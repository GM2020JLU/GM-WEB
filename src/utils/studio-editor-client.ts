import { renderMarkdownPreview } from './markdown-preview';
import { studioAssetReference } from './studio-assets';
import {
  deploymentCopy,
  readPendingDeployment,
  STUDIO_DEPLOYMENT_STORAGE_KEY,
  type PendingStudioDeployment,
  type StudioDeploymentState,
} from './studio-deployment';
import { generateStudioSlug } from './studio-slug';

export type StudioEditorOptions = {
  collection: string;
  fetch?: typeof globalThis.fetch;
  initialSlug: string;
  isNew: boolean;
  pollDelay?: number;
  setTimeout?: typeof globalThis.setTimeout;
};

type DocumentPayload = {
  document?: {
    body: string;
    metadata: Record<string, unknown>;
    sha?: string;
    slug: string;
  };
  error?: string;
  loginUrl?: string;
  taxonomies?: Partial<Record<'categories' | 'series' | 'tags', string[]>>;
};

type StudioEditorAsset = {
  name: string;
  path: string;
  size: number;
  url: string;
};

export type StudioLineDiff = { kind: 'added' | 'removed' | 'same'; value: string };

export function diffStudioLines(before: string, after: string, limit = 500): StudioLineDiff[] {
  const beforeLines = before.split('\n').slice(0, limit);
  const afterLines = after.split('\n').slice(0, limit);
  const rows = beforeLines.length + 1;
  const columns = afterLines.length + 1;
  const table = Array.from({ length: rows }, () => new Uint16Array(columns));
  for (let left = beforeLines.length - 1; left >= 0; left--) {
    for (let right = afterLines.length - 1; right >= 0; right--) {
      table[left][right] =
        beforeLines[left] === afterLines[right]
          ? table[left + 1][right + 1] + 1
          : Math.max(table[left + 1][right], table[left][right + 1]);
    }
  }
  const result: StudioLineDiff[] = [];
  let left = 0;
  let right = 0;
  while (left < beforeLines.length || right < afterLines.length) {
    if (
      left < beforeLines.length &&
      right < afterLines.length &&
      beforeLines[left] === afterLines[right]
    ) {
      result.push({ kind: 'same', value: beforeLines[left] });
      left++;
      right++;
    } else if (
      right < afterLines.length &&
      (left >= beforeLines.length || table[left][right + 1] >= table[left + 1][right])
    ) {
      result.push({ kind: 'added', value: afterLines[right++] });
    } else {
      result.push({ kind: 'removed', value: beforeLines[left++] });
    }
  }
  if (before.split('\n').length > limit || after.split('\n').length > limit) {
    result.push({ kind: 'same', value: `… 差异预览仅显示前 ${limit} 行` });
  }
  return result;
}

type EditorRecoveryDraft = {
  expectedSha?: string;
  values: Record<string, string>;
  version: 2;
};

type LegacyEditorRecoveryDraft = {
  body: string;
  expectedSha?: string;
  metadata: Record<string, unknown>;
  slug: string;
};

function isEditorRecoveryDraft(value: unknown): value is EditorRecoveryDraft {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'version' in value &&
    value.version === 2 &&
    'values' in value &&
    value.values &&
    typeof value.values === 'object',
  );
}

const knownKeys = new Set([
  'title',
  'description',
  'date',
  'updatedDate',
  'publicationStatus',
  'draft',
  'creator',
  'type',
  'status',
  'tags',
  'categories',
  'series',
  'scheduledAt',
  'heroImage',
  'heroImageAlt',
  'showHeroImage',
  'comments',
  'sidebar',
  'align',
  'size',
  'rating',
  'review',
]);

function element<T extends Element>(document: Document, selector: string) {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`编辑器缺少必要控件：${selector}`);
  return value;
}

async function payload(response: Response) {
  try {
    return (await response.json()) as DocumentPayload & Record<string, any>;
  } catch {
    return { error: `服务器响应异常（HTTP ${response.status}）。` };
  }
}

function listValue(value: unknown) {
  return Array.isArray(value) ? value.join('，') : '';
}

function parseList(value: string) {
  return [
    ...new Set(
      value
        .split(/[,，]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function setupStudioEditor(document: Document, options: StudioEditorOptions) {
  const form = element<HTMLFormElement>(document, '[data-editor-form]');
  const title = element<HTMLInputElement>(document, '[data-title]');
  const slug = element<HTMLInputElement>(document, '[data-slug]');
  const slugPreview = element<HTMLElement>(document, '[data-slug-preview]');
  const description = element<HTMLTextAreaElement>(document, '[data-description]');
  const date = element<HTMLInputElement>(document, '[data-date]');
  const status = element<HTMLSelectElement>(document, '[data-publication-status]');
  const creator = element<HTMLInputElement>(document, '[data-creator]');
  const contentType = element<HTMLSelectElement>(document, '[data-content-type]');
  const progress = element<HTMLSelectElement>(document, '[data-progress]');
  const heroImage = document.querySelector<HTMLInputElement>('[data-hero-image]');
  const heroImageAlt = document.querySelector<HTMLInputElement>('[data-hero-image-alt]');
  const showHeroImage = document.querySelector<HTMLInputElement>('[data-show-hero-image]');
  const comments = document.querySelector<HTMLInputElement>('[data-comments]');
  const sidebarEnable = document.querySelector<HTMLInputElement>('[data-sidebar-enable]');
  const sidebarToc = document.querySelector<HTMLInputElement>('[data-sidebar-toc]');
  const sidebarRelated = document.querySelector<HTMLInputElement>('[data-sidebar-related]');
  const align = document.querySelector<HTMLSelectElement>('[data-align]');
  const size = document.querySelector<HTMLSelectElement>('[data-size]');
  const rating = document.querySelector<HTMLInputElement>('[data-rating]');
  const review = document.querySelector<HTMLInputElement>('[data-review]');
  const tags = element<HTMLInputElement>(document, '[data-tags]');
  const categories = element<HTMLInputElement>(document, '[data-categories]');
  const series = element<HTMLInputElement>(document, '[data-series]');
  const body = element<HTMLTextAreaElement>(document, '[data-body]');
  const scheduledAt = element<HTMLInputElement>(document, '[data-scheduled-at]');
  const extras = element<HTMLTextAreaElement>(document, '[data-extras]');
  const preview = element<HTMLElement>(document, '[data-preview]');
  const notice = element<HTMLElement>(document, '[data-notice]');
  const wordCount = element<HTMLElement>(document, '[data-word-count]');
  const previewVersion = document.querySelector<HTMLElement>('[data-preview-version]');
  const saveButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-action]')];
  const historyList = element<HTMLElement>(document, '[data-history-list]');
  const historyDialog = element<HTMLDialogElement>(document, '[data-history-dialog]');
  const deploymentTracker = element<HTMLElement>(document, '[data-deployment-tracker]');
  const deploymentTitle = element<HTMLElement>(document, '[data-deployment-title]');
  const deploymentDetail = element<HTMLElement>(document, '[data-deployment-detail]');
  const deploymentProgress = element<HTMLElement>(document, '[data-deployment-progress]');
  const deploymentLink = element<HTMLAnchorElement>(document, '[data-deployment-link]');
  const currentStatus = element<HTMLElement>(document, '[data-current-status]');
  const saveLabel = document.querySelector<HTMLButtonElement>('[data-save-label]');
  const publishButton = document.querySelector<HTMLButtonElement>('[data-action="publish"]');
  const readyButton = document.querySelector<HTMLButtonElement>('[data-action="ready"]');
  const scheduleButton = document.querySelector<HTMLButtonElement>('[data-action="schedule"]');
  const unpublishButton = document.querySelector<HTMLButtonElement>('[data-action="unpublish"]');
  const taxonomyInputs = { categories, series, tags } as const;
  const taxonomySuggestions = Object.fromEntries(
    (['categories', 'series', 'tags'] as const).map((key) => [
      key,
      document.querySelector<HTMLElement>(`[data-taxonomy-suggestions="${key}"]`),
    ]),
  ) as Record<'categories' | 'series' | 'tags', HTMLElement | null>;
  const taxonomyLists = Object.fromEntries(
    (['categories', 'series', 'tags'] as const).map((key) => [
      key,
      document.querySelector<HTMLDataListElement>(`[data-taxonomy-list="${key}"]`),
    ]),
  ) as Record<'categories' | 'series' | 'tags', HTMLDataListElement | null>;
  const assetDialog = document.querySelector<HTMLDialogElement>('[data-asset-dialog]');
  const assetGrid = document.querySelector<HTMLElement>('[data-asset-picker-grid]');
  const assetNotice = document.querySelector<HTMLElement>('[data-asset-notice]');
  const assetAlt = document.querySelector<HTMLInputElement>('[data-asset-alt]');
  const assetSearch = document.querySelector<HTMLInputElement>('[data-asset-search]');
  const assetUpload = document.querySelector<HTMLInputElement>('[data-asset-upload]');
  const historyDiff = document.querySelector<HTMLElement>('[data-history-diff]');
  const knownFieldContainers = [...document.querySelectorAll<HTMLElement>('[data-for]')];
  let originalSlug = options.initialSlug;
  let currentSha: string | undefined;
  let initialSnapshot = '';
  let isNew = options.isNew;
  let loading = false;
  let ready = false;
  const recoveryKeyFor = (value: string) => `gm-studio-recovery:${options.collection}:${value}`;
  let recoveryKey = recoveryKeyFor(options.initialSlug);
  const request = options.fetch ?? globalThis.fetch;
  const defer = options.setTimeout ?? globalThis.setTimeout;
  const pollDelay = options.pollDelay ?? 3000;
  const browserWindow = document.defaultView;
  if (!browserWindow) throw new Error('编辑器需要浏览器环境。');
  const storage = browserWindow.localStorage;
  let recoveryRevision = 0;
  let deploymentPollFailures = 0;
  let focusBeforeBusy: HTMLElement | null = null;
  let editorAssets: StudioEditorAsset[] = [];

  const apiUrl = () =>
    `/api/studio/content/${encodeURIComponent(options.collection)}/${encodeURIComponent(originalSlug)}`;
  const historyUrl = () =>
    `/api/studio/history/${encodeURIComponent(options.collection)}/${encodeURIComponent(originalSlug)}`;

  const showNotice = (heading: string, detail: string, kind = '') => {
    notice.className = `notice ${kind}`.trim();
    notice.innerHTML = `<strong></strong><small></small>`;
    notice.querySelector('strong')!.textContent = heading;
    notice.querySelector('small')!.textContent = detail;
    notice.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  };

  const appendNoticeAction = (label: string, action: () => void) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', action, { once: true });
    notice.append(button);
    return button;
  };

  const renderDeployment = (state: StudioDeploymentState, pending: PendingStudioDeployment) => {
    const copy = deploymentCopy(state);
    deploymentTracker.hidden = false;
    deploymentTracker.dataset.phase = state.phase;
    deploymentTitle.textContent = copy.title;
    deploymentDetail.textContent = copy.detail;
    deploymentProgress.style.width = `${copy.progress}%`;
    const link = state.phase === 'error' ? state.logUrl : pending.publicUrl;
    deploymentLink.hidden = (state.phase !== 'ready' && state.phase !== 'error') || !link;
    if (link) deploymentLink.href = link;
    deploymentLink.textContent = state.phase === 'error' ? '查看失败原因' : '打开线上页面';
  };

  const trackDeployment = async (pending: PendingStudioDeployment) => {
    if (deploymentTracker.hidden) {
      renderDeployment({ phase: 'submitted', targetSha: pending.targetSha }, pending);
    }
    try {
      const response = await request(
        `/api/studio/deployment?sha=${encodeURIComponent(pending.targetSha)}`,
      );
      const result = (await response.json()) as {
        deployment?: StudioDeploymentState;
        error?: string;
      };
      if (!response.ok || !result.deployment) throw new Error(result.error || '无法读取部署状态。');
      deploymentPollFailures = 0;
      renderDeployment(result.deployment, pending);
      if (result.deployment.phase === 'ready') {
        storage.removeItem(STUDIO_DEPLOYMENT_STORAGE_KEY);
        showNotice('发布完成', '网站已经更新，可以打开线上页面。', 'success');
        return;
      }
      if (result.deployment.phase === 'error') return;
      defer(() => void trackDeployment(pending), pollDelay);
    } catch {
      deploymentPollFailures++;
      deploymentTitle.textContent = '仍在等待部署';
      deploymentDetail.textContent =
        deploymentPollFailures >= 5
          ? '内容已经安全保存，请稍后刷新页面重新查看部署状态。'
          : '暂时无法取得进度，将自动重试。内容已经安全保存。';
      if (deploymentPollFailures < 5) {
        defer(() => void trackDeployment(pending), pollDelay * 2);
      }
    }
  };

  const setBusy = (busy: boolean) => {
    loading = busy;
    if (busy) {
      const active = document.activeElement;
      focusBeforeBusy = active && form.contains(active) ? (active as HTMLElement) : null;
    }
    form.inert = busy;
    form.setAttribute('aria-busy', String(busy));
    saveButtons.forEach((button) => (button.disabled = busy || !ready));
    if (!busy) {
      if (focusBeforeBusy?.isConnected) focusBeforeBusy.focus();
      focusBeforeBusy = null;
    }
  };

  const applyVisibility = () => {
    knownFieldContainers.forEach((container) => {
      const collections = container.dataset.for?.split(',') ?? [];
      container.hidden = !collections.includes(options.collection);
    });
    slug.readOnly = true;
    body.closest<HTMLElement>('[data-body-panel]')!.hidden = [
      'categories',
      'series',
      'tags',
    ].includes(options.collection);
  };

  const updateStatusActions = () => {
    const value = status.value;
    currentStatus.textContent =
      value === 'published' ? '已发布' : value === 'ready' ? '待发布' : '草稿';
    currentStatus.dataset.status = value;
    if (saveLabel) {
      saveLabel.textContent =
        value === 'published' ? '保存并更新线上版本' : value === 'ready' ? '保存更改' : '保存草稿';
    }
    if (publishButton) publishButton.hidden = value === 'published';
    if (readyButton) readyButton.hidden = value !== 'draft';
    if (scheduleButton) scheduleButton.hidden = value === 'published';
    if (unpublishButton) unpublishButton.hidden = value !== 'published';
  };

  const populateTaxonomyOptions = (values: DocumentPayload['taxonomies'] = {}) => {
    (['categories', 'series', 'tags'] as const).forEach((key) => {
      const available = values?.[key] ?? [];
      const list = taxonomyLists[key];
      if (list) {
        list.replaceChildren(
          ...available.map((value) => {
            const option = document.createElement('option');
            option.value = value;
            return option;
          }),
        );
      }
      const renderSuggestions = () => {
        const container = taxonomySuggestions[key];
        if (!container) return;
        const selected = new Set(parseList(taxonomyInputs[key].value));
        container.replaceChildren(
          ...available
            .filter((value) => !selected.has(value))
            .slice(0, 8)
            .map((value) => {
              const chip = document.createElement('button');
              chip.type = 'button';
              chip.textContent = `+ ${value}`;
              chip.addEventListener('click', () => {
                taxonomyInputs[key].value = [...selected, value].join('，');
                taxonomyInputs[key].dispatchEvent(
                  new browserWindow.Event('input', { bubbles: true }),
                );
                taxonomyInputs[key].focus();
              });
              return chip;
            }),
        );
      };
      taxonomyInputs[key].addEventListener('input', renderSuggestions);
      renderSuggestions();
    });
  };

  const populate = (
    metadata: Record<string, unknown>,
    source: string,
    loadedSlug: string,
    loadedSha?: string,
  ) => {
    currentSha = loadedSha;
    title.value = typeof metadata.title === 'string' ? metadata.title : '';
    slug.value = isNew ? '' : loadedSlug;
    slugPreview.textContent = isNew ? '保存时自动生成' : loadedSlug;
    description.value = typeof metadata.description === 'string' ? metadata.description : '';
    date.value = typeof metadata.date === 'string' ? metadata.date.slice(0, 16) : '';
    status.value =
      typeof metadata.publicationStatus === 'string' ? metadata.publicationStatus : 'draft';
    updateStatusActions();
    scheduledAt.value =
      typeof metadata.scheduledAt === 'string' ? metadata.scheduledAt.slice(0, 16) : '';
    creator.value = typeof metadata.creator === 'string' ? metadata.creator : '';
    contentType.value = typeof metadata.type === 'string' ? metadata.type : contentType.value;
    progress.value = typeof metadata.status === 'string' ? metadata.status : progress.value;
    tags.value = listValue(metadata.tags);
    categories.value = listValue(metadata.categories);
    series.value = listValue(metadata.series);
    if (heroImage)
      heroImage.value = typeof metadata.heroImage === 'string' ? metadata.heroImage : '';
    if (heroImageAlt) {
      heroImageAlt.value = typeof metadata.heroImageAlt === 'string' ? metadata.heroImageAlt : '';
    }
    if (showHeroImage) showHeroImage.checked = metadata.showHeroImage !== false;
    if (comments) comments.checked = metadata.comments !== false;
    const sidebar =
      metadata.sidebar && typeof metadata.sidebar === 'object' && !Array.isArray(metadata.sidebar)
        ? (metadata.sidebar as Record<string, unknown>)
        : {};
    if (sidebarEnable) sidebarEnable.checked = sidebar.enable !== false;
    if (sidebarToc) sidebarToc.checked = sidebar.toc !== false;
    if (sidebarRelated) sidebarRelated.checked = sidebar.relatedPosts !== false;
    if (align) align.value = typeof metadata.align === 'string' ? metadata.align : 'left';
    if (size) size.value = typeof metadata.size === 'string' ? metadata.size : 'md';
    if (rating) rating.value = typeof metadata.rating === 'number' ? String(metadata.rating) : '';
    if (review) review.checked = metadata.review === true;
    body.value = source;
    extras.value = JSON.stringify(
      Object.fromEntries(Object.entries(metadata).filter(([key]) => !knownKeys.has(key))),
      null,
      2,
    );
    renderPreview();
    initialSnapshot = snapshot();
    updateDirtyState();
  };

  const collect = () => {
    const visible = (control: Element | null) =>
      Boolean(control && !control.closest<HTMLElement>('[data-for]')?.hidden);
    let extraMetadata: Record<string, unknown> = {};
    if (extras.value.trim()) {
      const parsed = JSON.parse(extras.value) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('高级字段必须是 JSON 对象。');
      }
      extraMetadata = parsed as Record<string, unknown>;
    }
    const metadata: Record<string, unknown> = {
      ...extraMetadata,
      title: title.value.trim(),
      publicationStatus: status.value,
      draft: status.value !== 'published',
    };
    if (!description.closest<HTMLElement>('[data-for]')?.hidden && description.value.trim()) {
      metadata.description = description.value.trim();
    }
    if (!date.closest<HTMLElement>('[data-for]')?.hidden && date.value) {
      metadata.date = `${date.value}:00+08:00`;
    }
    if (!creator.closest<HTMLElement>('[data-for]')?.hidden && creator.value.trim()) {
      metadata.creator = creator.value.trim();
    }
    if (!scheduledAt.closest<HTMLElement>('[data-for]')?.hidden && scheduledAt.value) {
      metadata.scheduledAt = `${scheduledAt.value}:00+08:00`;
    }
    if (!contentType.closest<HTMLElement>('[data-for]')?.hidden) metadata.type = contentType.value;
    if (!progress.closest<HTMLElement>('[data-for]')?.hidden) metadata.status = progress.value;
    if (!tags.closest<HTMLElement>('[data-for]')?.hidden) metadata.tags = parseList(tags.value);
    if (!categories.closest<HTMLElement>('[data-for]')?.hidden)
      metadata.categories = parseList(categories.value);
    if (!series.closest<HTMLElement>('[data-for]')?.hidden)
      metadata.series = parseList(series.value);
    if (visible(heroImage) && heroImage?.value.trim()) metadata.heroImage = heroImage.value.trim();
    if (visible(heroImageAlt) && heroImageAlt?.value.trim()) {
      metadata.heroImageAlt = heroImageAlt.value.trim();
    }
    if (visible(showHeroImage)) metadata.showHeroImage = showHeroImage?.checked ?? true;
    if (visible(comments)) metadata.comments = comments?.checked ?? true;
    if (visible(sidebarEnable)) {
      metadata.sidebar = {
        enable: sidebarEnable?.checked ?? true,
        toc: sidebarToc?.checked ?? true,
        relatedPosts: sidebarRelated?.checked ?? true,
      };
    }
    if (visible(align) && align) metadata.align = align.value;
    if (visible(size) && size) metadata.size = size.value;
    if (visible(rating) && rating?.value) metadata.rating = Number(rating.value);
    if (visible(review)) metadata.review = review?.checked ?? false;
    return {
      body: body.value,
      expectedSha: currentSha,
      metadata,
      slug: slug.value.trim(),
      originalSlug,
    };
  };

  const recoveryValues = () => ({
    body: body.value,
    categories: categories.value,
    contentType: contentType.value,
    creator: creator.value,
    date: date.value,
    description: description.value,
    extras: extras.value,
    heroImage: heroImage?.value ?? '',
    heroImageAlt: heroImageAlt?.value ?? '',
    showHeroImage: String(showHeroImage?.checked ?? true),
    comments: String(comments?.checked ?? true),
    sidebarEnable: String(sidebarEnable?.checked ?? true),
    sidebarToc: String(sidebarToc?.checked ?? true),
    sidebarRelated: String(sidebarRelated?.checked ?? true),
    align: align?.value ?? '',
    size: size?.value ?? '',
    rating: rating?.value ?? '',
    review: String(review?.checked ?? false),
    progress: progress.value,
    scheduledAt: scheduledAt.value,
    series: series.value,
    slug: slug.value,
    status: status.value,
    tags: tags.value,
    title: title.value,
  });

  const migrateLegacyRecovery = (draft: LegacyEditorRecoveryDraft): EditorRecoveryDraft => {
    const metadata =
      draft.metadata && typeof draft.metadata === 'object' && !Array.isArray(draft.metadata)
        ? draft.metadata
        : {};
    const sidebar =
      metadata.sidebar && typeof metadata.sidebar === 'object' && !Array.isArray(metadata.sidebar)
        ? (metadata.sidebar as Record<string, unknown>)
        : {};
    const publicationStatus = ['draft', 'ready', 'published'].includes(
      String(metadata.publicationStatus),
    )
      ? String(metadata.publicationStatus)
      : metadata.draft === false
        ? 'published'
        : 'draft';
    return {
      expectedSha: draft.expectedSha,
      version: 2,
      values: {
        align: typeof metadata.align === 'string' ? metadata.align : 'left',
        body: typeof draft.body === 'string' ? draft.body : '',
        categories: listValue(metadata.categories),
        comments: String(metadata.comments !== false),
        contentType:
          typeof metadata.type === 'string'
            ? metadata.type
            : options.collection === 'media'
              ? 'book'
              : 'text',
        creator: typeof metadata.creator === 'string' ? metadata.creator : '',
        date: typeof metadata.date === 'string' ? metadata.date.slice(0, 16) : '',
        description: typeof metadata.description === 'string' ? metadata.description : '',
        extras: JSON.stringify(
          Object.fromEntries(Object.entries(metadata).filter(([key]) => !knownKeys.has(key))),
          null,
          2,
        ),
        heroImage: typeof metadata.heroImage === 'string' ? metadata.heroImage : '',
        heroImageAlt: typeof metadata.heroImageAlt === 'string' ? metadata.heroImageAlt : '',
        progress: typeof metadata.status === 'string' ? metadata.status : 'planned',
        rating: typeof metadata.rating === 'number' ? String(metadata.rating) : '',
        review: String(metadata.review === true),
        scheduledAt:
          typeof metadata.scheduledAt === 'string' ? metadata.scheduledAt.slice(0, 16) : '',
        series: listValue(metadata.series),
        showHeroImage: String(metadata.showHeroImage !== false),
        sidebarEnable: String(sidebar.enable !== false),
        sidebarRelated: String(sidebar.relatedPosts !== false),
        sidebarToc: String(sidebar.toc !== false),
        size: typeof metadata.size === 'string' ? metadata.size : 'md',
        slug: typeof draft.slug === 'string' ? draft.slug : originalSlug,
        status: publicationStatus,
        tags: listValue(metadata.tags),
        title: typeof metadata.title === 'string' ? metadata.title : '',
      },
    };
  };

  const snapshot = () => JSON.stringify(recoveryValues());

  const updateDirtyState = () => {
    const dirty = Boolean(initialSnapshot && snapshot() !== initialSnapshot);
    form.dataset.dirty = String(dirty);
    if (previewVersion) {
      previewVersion.textContent = dirty ? '编辑器预览 · 未保存版本' : '编辑器预览 · 已保存版本';
    }
  };

  const applyRecoveryValues = (values: Record<string, string>) => {
    const controls: Record<
      string,
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null
    > = {
      align,
      body,
      categories,
      comments,
      contentType,
      creator,
      date,
      description,
      extras,
      heroImage,
      heroImageAlt,
      progress,
      rating,
      review,
      scheduledAt,
      series,
      showHeroImage,
      sidebarEnable,
      sidebarRelated,
      sidebarToc,
      size,
      slug,
      status,
      tags,
      title,
    };
    Object.entries(values).forEach(([key, value]) => {
      const control = controls[key];
      if (!control || typeof value !== 'string') return;
      if (control instanceof browserWindow.HTMLInputElement && control.type === 'checkbox') {
        control.checked = value === 'true';
      } else {
        control.value = value;
      }
    });
    slugPreview.textContent = slug.value || '保存时自动生成';
    updateStatusActions();
    renderPreview();
    updateDirtyState();
  };

  const persistRecovery = () => {
    if (initialSnapshot && snapshot() !== initialSnapshot) {
      storage.setItem(
        recoveryKey,
        JSON.stringify({
          expectedSha: currentSha,
          values: recoveryValues(),
          version: 2,
        } satisfies EditorRecoveryDraft),
      );
    } else {
      storage.removeItem(recoveryKey);
    }
  };

  const scheduleRecovery = () => {
    const revision = ++recoveryRevision;
    defer(() => {
      if (revision === recoveryRevision) persistRecovery();
    }, 900);
  };

  function renderPreview() {
    preview.innerHTML = body.value.trim()
      ? renderMarkdownPreview(body.value)
      : '<p class="empty-preview">正文预览会显示在这里。</p>';
    wordCount.textContent = `${body.value.replace(/\s+/g, '').length.toLocaleString('zh-CN')} 字符`;
    updateDirtyState();
  }

  const showAssetNotice = (message: string, error = false) => {
    if (!assetNotice) return;
    assetNotice.textContent = message;
    assetNotice.className = `asset-picker-notice${error ? ' error' : ''}`;
    assetNotice.setAttribute('role', error ? 'alert' : 'status');
  };

  const insertAssetReference = (reference: string) => {
    if (!assetAlt?.value.trim()) {
      showAssetNotice('请先填写替代文本，让图片对读屏用户也有意义。', true);
      assetAlt?.focus();
      return;
    }
    const safeAlt = assetAlt.value.trim().replaceAll(']', '\\]');
    const markdown = `![${safeAlt}](${reference})`;
    const start = body.selectionStart ?? body.value.length;
    const end = body.selectionEnd ?? start;
    const prefix = start > 0 && body.value[start - 1] !== '\n' ? '\n\n' : '';
    const suffix = end < body.value.length && body.value[end] !== '\n' ? '\n\n' : '\n';
    body.setRangeText(`${prefix}${markdown}${suffix}`, start, end, 'end');
    body.dispatchEvent(new browserWindow.Event('input', { bubbles: true }));
    assetDialog?.close();
    body.focus();
  };

  const renderEditorAssets = () => {
    if (!assetGrid) return;
    const query = assetSearch?.value.trim().toLocaleLowerCase('zh-CN') ?? '';
    const visible = editorAssets.filter((asset) =>
      asset.name.toLocaleLowerCase('zh-CN').includes(query),
    );
    assetGrid.replaceChildren(
      ...visible.map((asset) => {
        const card = document.createElement('article');
        const image = document.createElement('img');
        const name = document.createElement('strong');
        const choose = document.createElement('button');
        image.src = asset.url;
        image.alt = '';
        image.loading = 'lazy';
        name.textContent = asset.name;
        choose.type = 'button';
        choose.textContent = '插入正文';
        choose.addEventListener('click', () =>
          insertAssetReference(studioAssetReference(asset.path)),
        );
        card.append(image, name, choose);
        return card;
      }),
    );
    if (!visible.length)
      showAssetNotice(editorAssets.length ? '没有匹配的素材。' : '还没有素材，可以直接上传。');
  };

  const loadEditorAssets = async () => {
    if (!assetGrid) return;
    showAssetNotice('正在读取素材…');
    try {
      const response = await request('/api/studio/assets');
      const result = await payload(response);
      if (!response.ok || !Array.isArray(result.assets)) {
        throw new Error(result.error || '素材加载失败。');
      }
      editorAssets = result.assets as StudioEditorAsset[];
      renderEditorAssets();
      if (editorAssets.length) showAssetNotice(`已读取 ${editorAssets.length} 张图片。`);
    } catch (error) {
      showAssetNotice(error instanceof Error ? error.message : '素材加载失败。', true);
    }
  };

  const load = async () => {
    ready = false;
    form.hidden = true;
    setBusy(true);
    showNotice('正在读取内容', '从当前内容源加载最新版本。');
    try {
      const response = await request(`${apiUrl()}${isNew ? '?new=1' : ''}`);
      const result = await payload(response);
      if (!response.ok || !result.document) {
        if (result.loginUrl) {
          showNotice('需要登录', `${result.error} 请先登录后刷新页面。`, 'error');
          const link = document.createElement('a');
          link.href = result.loginUrl;
          link.textContent = '登录 GitHub';
          link.target = '_blank';
          notice.append(link);
          return;
        }
        throw new Error(result.error || '内容加载失败。');
      }
      populate(
        result.document.metadata,
        result.document.body,
        result.document.slug,
        result.document.sha,
      );
      populateTaxonomyOptions(result.taxonomies);
      ready = true;
      form.hidden = false;
      const serverSnapshot = initialSnapshot;
      const serverSha = currentSha;
      const recovered = storage.getItem(recoveryKey);
      if (recovered) {
        try {
          const parsed = JSON.parse(recovered) as unknown;
          const draft = isEditorRecoveryDraft(parsed)
            ? parsed
            : migrateLegacyRecovery(parsed as LegacyEditorRecoveryDraft);
          const recoveredSnapshot = JSON.stringify(draft.values);
          const staleRecovery = Boolean(
            draft.expectedSha && serverSha && draft.expectedSha !== serverSha,
          );
          const recoveryPrompt = staleRecovery
            ? '服务器版本已在本地编辑后发生变化。是否将本地编辑覆盖到最新版本上？发布状态会保持服务器最新值。'
            : '发现尚未提交的本地编辑，是否恢复？';
          if (recoveredSnapshot !== serverSnapshot && browserWindow.confirm(recoveryPrompt)) {
            const recoveredValues = staleRecovery
              ? Object.fromEntries(Object.entries(draft.values).filter(([key]) => key !== 'status'))
              : draft.values;
            applyRecoveryValues(recoveredValues);
            currentSha = serverSha;
            initialSnapshot = serverSnapshot;
            updateDirtyState();
            showNotice(
              '已恢复本地编辑',
              staleRecovery
                ? '已基于服务器最新版本恢复；请先检查差异，再保存。'
                : '请检查内容后保存到仓库。',
              'success',
            );
            return;
          }
          storage.removeItem(recoveryKey);
        } catch {
          storage.removeItem(recoveryKey);
        }
      }
      showNotice(
        options.isNew ? '新内容已就绪' : '已载入最新版本',
        '普通保存会保持当前发布状态。',
        'success',
      );
    } catch (error) {
      showNotice('无法加载内容', error instanceof Error ? error.message : '请刷新重试。', 'error');
      appendNoticeAction('重新读取', () => void load());
    } finally {
      setBusy(false);
    }
  };

  const save = async (action?: string) => {
    if (loading || !ready || !form.reportValidity()) return;
    if (action === 'schedule' && !scheduledAt.value) {
      showNotice('请选择发布时间', '定时发布需要填写日期和时间。', 'error');
      return;
    }
    let submitted: ReturnType<typeof collect>;
    try {
      submitted = collect();
    } catch (error) {
      persistRecovery();
      showNotice(
        '无法保存',
        error instanceof Error ? error.message : '请检查高级字段格式。',
        'error',
      );
      return;
    }
    setBusy(true);
    showNotice('正在保存', action === 'publish' ? '正在提交发布版本。' : '正在提交内容变更。');
    const attemptedCreate = isNew;
    try {
      const response = await request(apiUrl(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...submitted, action }),
      });
      const result = await payload(response);
      if (response.status === 409) {
        persistRecovery();
        showNotice(
          '内容已在其他位置更新',
          '你的编辑已保留在本机。请读取最新版本，再确认是否恢复本地编辑。',
          'error',
        );
        appendNoticeAction('读取最新版本', () => void load());
        return;
      }
      if (!response.ok) throw new Error(result.error || '保存失败。');
      if (typeof result.sha !== 'string') throw new Error('服务器未返回最新内容版本。');
      storage.removeItem(recoveryKey);
      originalSlug = result.slug;
      currentSha = result.sha;
      isNew = false;
      recoveryKey = recoveryKeyFor(result.slug);
      slug.value = result.slug;
      slugPreview.textContent = result.slug;
      status.value = result.status;
      updateStatusActions();
      initialSnapshot = snapshot();
      updateDirtyState();
      browserWindow.history.replaceState(
        {},
        '',
        `/studio/edit/${options.collection}/${result.slug}`,
      );
      const message = result.deploymentPending
        ? result.deploymentProvider === 'local'
          ? '内容已保存到 Mac，下面会持续显示本地构建和上线进度。'
          : '内容已保存到 GitHub，下面会持续显示网站上线进度。'
        : '已保存到本地内容目录。';
      showNotice(
        action === 'schedule'
          ? '定时发布已安排'
          : action === 'publish'
            ? '发布已提交'
            : result.status === 'published'
              ? '线上版本更新已提交'
              : '保存成功',
        message,
        'success',
      );
      if (result.deploymentPending && result.commitSha) {
        const pending: PendingStudioDeployment = {
          targetSha: result.commitSha,
          publicUrl: result.publicUrl,
          title: title.value.trim(),
          startedAt: new Date().toISOString(),
        };
        storage.setItem(STUDIO_DEPLOYMENT_STORAGE_KEY, JSON.stringify(pending));
        void trackDeployment(pending);
      }
    } catch (error) {
      if (attemptedCreate && submitted.slug) {
        try {
          const probeUrl = `/api/studio/content/${encodeURIComponent(options.collection)}/${encodeURIComponent(submitted.slug)}`;
          const probeResponse = await request(probeUrl);
          const probe = await payload(probeResponse);
          if (
            probeResponse.ok &&
            probe.document &&
            probe.document.sha &&
            probe.document.body.trim() === submitted.body.trim() &&
            Object.entries({
              ...submitted.metadata,
              ...(action
                ? {
                    draft:
                      action === 'save'
                        ? submitted.metadata.publicationStatus !== 'published'
                        : action !== 'publish',
                    publicationStatus:
                      action === 'publish'
                        ? 'published'
                        : action === 'ready' || action === 'schedule'
                          ? 'ready'
                          : action === 'save'
                            ? submitted.metadata.publicationStatus
                            : 'draft',
                  }
                : {}),
            }).every(([key, value]) =>
              key === 'scheduledAt' && action === 'publish'
                ? probe.document?.metadata[key] === undefined
                : JSON.stringify(probe.document?.metadata[key]) === JSON.stringify(value),
            )
          ) {
            storage.removeItem(recoveryKey);
            originalSlug = probe.document.slug;
            currentSha = probe.document.sha;
            isNew = false;
            recoveryKey = recoveryKeyFor(probe.document.slug);
            populate(
              probe.document.metadata,
              probe.document.body,
              probe.document.slug,
              probe.document.sha,
            );
            browserWindow.history.replaceState(
              {},
              '',
              `/studio/edit/${options.collection}/${probe.document.slug}`,
            );
            showNotice(
              '内容已经保存',
              '上次保存的响应中断，但已从内容仓库确认写入结果；如需发布，请返回总览查看状态。',
              'success',
            );
            return;
          }
        } catch {
          // The original error below is more useful when the verification request also fails.
        }
      }
      showNotice('操作未完成', error instanceof Error ? error.message : '请稍后重试。', 'error');
    } finally {
      setBusy(false);
    }
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void save('save');
  });
  saveButtons.forEach((button) => {
    button.addEventListener('click', () => void save(button.dataset.action));
  });
  body.addEventListener('input', renderPreview);
  form.addEventListener('input', () => {
    updateDirtyState();
    scheduleRecovery();
  });
  form.addEventListener('change', scheduleRecovery);
  title.addEventListener('input', () => {
    if (!isNew) return;
    slug.value = ['categories', 'series', 'tags'].includes(options.collection)
      ? title.value.trim()
      : generateStudioSlug(title.value);
    slugPreview.textContent = slug.value || '保存时自动生成';
  });
  browserWindow.addEventListener('pagehide', persistRecovery);
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase('en-US') === 's') {
      event.preventDefault();
      void save('save');
    }
  });
  const viewButtons = [...document.querySelectorAll<HTMLElement>('.view-switch [data-view]')];
  const setEditorView = (view: string) => {
    viewButtons.forEach((item) =>
      item.setAttribute('aria-pressed', String(item.dataset.view === view)),
    );
    document.querySelector<HTMLElement>('[data-body-panel]')!.dataset.editorView = view;
  };
  if (
    typeof browserWindow.matchMedia === 'function' &&
    browserWindow.matchMedia('(max-width: 820px)').matches
  ) {
    setEditorView('edit');
  }
  viewButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const view = button.dataset.view;
      if (view) setEditorView(view);
    });
  });

  document.querySelector('[data-open-asset-picker]')?.addEventListener('click', () => {
    assetDialog?.showModal();
    void loadEditorAssets();
  });
  assetSearch?.addEventListener('input', renderEditorAssets);
  assetUpload?.addEventListener('change', async () => {
    const file = assetUpload.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      assetUpload.value = '';
      showAssetNotice('单张图片不能超过 5 MB。', true);
      return;
    }
    const upload = new browserWindow.FormData();
    upload.append('file', file);
    assetUpload.disabled = true;
    showAssetNotice('正在验证并上传图片…');
    try {
      const response = await request('/api/studio/assets', { method: 'POST', body: upload });
      const result = await payload(response);
      if (!response.ok) throw new Error(result.error || '图片上传失败。');
      await loadEditorAssets();
      showAssetNotice('上传成功，可以从下方选择插入。');
    } catch (error) {
      showAssetNotice(error instanceof Error ? error.message : '图片上传失败。', true);
    } finally {
      assetUpload.disabled = false;
      assetUpload.value = '';
    }
  });

  document.querySelector('[data-history]')?.addEventListener('click', async () => {
    historyDialog.showModal();
    historyList.textContent = '正在读取历史记录…';
    try {
      const response = await request(historyUrl());
      const result = await payload(response);
      if (!response.ok) throw new Error(result.error || '历史记录加载失败。');
      historyList.replaceChildren(
        ...(result.history.length
          ? result.history.map((entry: any) => {
              const item = document.createElement('article');
              const heading = document.createElement('strong');
              const meta = document.createElement('small');
              const actions = document.createElement('div');
              const compare = document.createElement('button');
              const restore = document.createElement('button');
              heading.textContent = entry.message.split('\n')[0];
              meta.textContent = `${entry.author} · ${new Date(entry.date).toLocaleString('zh-CN')}`;
              compare.type = 'button';
              compare.textContent = '查看差异';
              compare.addEventListener('click', async () => {
                if (!historyDiff) return;
                historyDiff.hidden = false;
                historyDiff.textContent = '正在计算与当前编辑内容的差异…';
                try {
                  const historical = await request(
                    `${historyUrl()}?ref=${encodeURIComponent(entry.sha)}`,
                  );
                  const historicalPayload = await payload(historical);
                  if (!historical.ok || !historicalPayload.document) {
                    throw new Error(historicalPayload.error || '无法读取该版本。');
                  }
                  const diff = diffStudioLines(historicalPayload.document.body, body.value);
                  const title = document.createElement('strong');
                  const note = document.createElement('small');
                  const code = document.createElement('pre');
                  title.textContent = `与 ${entry.sha.slice(0, 7)} 的差异`;
                  note.textContent = '“+”是当前编辑新增，“−”是历史版本中已移除。';
                  code.append(
                    ...diff.map((line) => {
                      const row = document.createElement('span');
                      row.className = `diff-${line.kind}`;
                      row.textContent = `${
                        line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '
                      } ${line.value}\n`;
                      return row;
                    }),
                  );
                  historyDiff.replaceChildren(title, note, code);
                  historyDiff.scrollIntoView?.({ block: 'nearest' });
                } catch (error) {
                  historyDiff.textContent =
                    error instanceof Error ? error.message : '无法生成差异预览。';
                }
              });
              restore.type = 'button';
              restore.textContent = '恢复此版本';
              restore.addEventListener('click', async () => {
                if (
                  !browserWindow.confirm(
                    `确定恢复 ${entry.sha.slice(0, 7)} 吗？当前版本仍会保留在历史中。`,
                  )
                )
                  return;
                const restored = await request(historyUrl(), {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ expectedSha: currentSha, ref: entry.sha }),
                });
                const restoredPayload = await payload(restored);
                if (!restored.ok) return browserWindow.alert(restoredPayload.error || '恢复失败。');
                if (restoredPayload.deploymentPending && restoredPayload.commitSha) {
                  storage.setItem(
                    STUDIO_DEPLOYMENT_STORAGE_KEY,
                    JSON.stringify({
                      targetSha: restoredPayload.commitSha,
                      publicUrl: restoredPayload.publicUrl,
                      title: title.value.trim(),
                      startedAt: new Date().toISOString(),
                    }),
                  );
                }
                browserWindow.location.reload();
              });
              actions.append(compare, restore);
              item.append(heading, meta, actions);
              return item;
            })
          : [document.createTextNode('暂无可用的本地备份；保存下一次变更后会自动生成。')]),
      );
    } catch (error) {
      historyList.textContent = error instanceof Error ? error.message : '历史记录加载失败。';
    }
  });
  document.querySelector('[data-delete]')?.addEventListener('click', async () => {
    if (!browserWindow.confirm('删除后将从公开网站移除这条内容，确定继续吗？')) return;
    if (!currentSha) {
      showNotice('无法删除', '缺少内容版本，请刷新后重试。', 'error');
      return;
    }
    const response = await request(apiUrl(), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedSha: currentSha }),
    });
    const result = await payload(response);
    if (!response.ok) return showNotice('删除失败', result.error || '请稍后重试。', 'error');
    if (result.deploymentPending && result.commitSha) {
      storage.setItem(
        STUDIO_DEPLOYMENT_STORAGE_KEY,
        JSON.stringify({
          targetSha: result.commitSha,
          title: title.value.trim(),
          startedAt: new Date().toISOString(),
        }),
      );
    }
    browserWindow.location.assign('/studio');
  });
  browserWindow.addEventListener('beforeunload', (event) => {
    if (initialSnapshot && snapshot() !== initialSnapshot) event.preventDefault();
  });

  applyVisibility();
  const pendingDeployment = readPendingDeployment(storage);
  if (pendingDeployment) void trackDeployment(pendingDeployment);
  void load();
}
