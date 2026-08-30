import { renderMarkdownPreview } from './markdown-preview';
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
};

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
  return value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
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
  const tags = element<HTMLInputElement>(document, '[data-tags]');
  const categories = element<HTMLInputElement>(document, '[data-categories]');
  const series = element<HTMLInputElement>(document, '[data-series]');
  const body = element<HTMLTextAreaElement>(document, '[data-body]');
  const scheduledAt = element<HTMLInputElement>(document, '[data-scheduled-at]');
  const extras = element<HTMLTextAreaElement>(document, '[data-extras]');
  const preview = element<HTMLElement>(document, '[data-preview]');
  const notice = element<HTMLElement>(document, '[data-notice]');
  const wordCount = element<HTMLElement>(document, '[data-word-count]');
  const saveButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-action]')];
  const historyList = element<HTMLElement>(document, '[data-history-list]');
  const historyDialog = element<HTMLDialogElement>(document, '[data-history-dialog]');
  const deploymentTracker = element<HTMLElement>(document, '[data-deployment-tracker]');
  const deploymentTitle = element<HTMLElement>(document, '[data-deployment-title]');
  const deploymentDetail = element<HTMLElement>(document, '[data-deployment-detail]');
  const deploymentProgress = element<HTMLElement>(document, '[data-deployment-progress]');
  const deploymentLink = element<HTMLAnchorElement>(document, '[data-deployment-link]');
  const currentStatus = element<HTMLElement>(document, '[data-current-status]');
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
    currentStatus.textContent =
      status.value === 'published' ? '已发布' : status.value === 'ready' ? '待发布' : '草稿';
    scheduledAt.value =
      typeof metadata.scheduledAt === 'string' ? metadata.scheduledAt.slice(0, 16) : '';
    creator.value = typeof metadata.creator === 'string' ? metadata.creator : '';
    contentType.value = typeof metadata.type === 'string' ? metadata.type : contentType.value;
    progress.value = typeof metadata.status === 'string' ? metadata.status : progress.value;
    tags.value = listValue(metadata.tags);
    categories.value = listValue(metadata.categories);
    series.value = listValue(metadata.series);
    body.value = source;
    extras.value = JSON.stringify(
      Object.fromEntries(Object.entries(metadata).filter(([key]) => !knownKeys.has(key))),
      null,
      2,
    );
    renderPreview();
    initialSnapshot = snapshot();
  };

  const collect = () => {
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
    progress: progress.value,
    scheduledAt: scheduledAt.value,
    series: series.value,
    slug: slug.value,
    status: status.value,
    tags: tags.value,
    title: title.value,
  });

  const snapshot = () => JSON.stringify(recoveryValues());

  const applyRecoveryValues = (values: Record<string, string>) => {
    const controls: Record<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement> = {
      body,
      categories,
      contentType,
      creator,
      date,
      description,
      extras,
      progress,
      scheduledAt,
      series,
      slug,
      status,
      tags,
      title,
    };
    Object.entries(values).forEach(([key, value]) => {
      if (controls[key] && typeof value === 'string') controls[key].value = value;
    });
    slugPreview.textContent = slug.value || '保存时自动生成';
    currentStatus.textContent =
      status.value === 'published' ? '已发布' : status.value === 'ready' ? '待发布' : '草稿';
    renderPreview();
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
  }

  const load = async () => {
    ready = false;
    setBusy(true);
    showNotice('正在读取内容', '从当前内容源加载最新版本。');
    try {
      const response = await request(`${apiUrl()}${options.isNew ? '?new=1' : ''}`);
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
      ready = true;
      const serverSnapshot = initialSnapshot;
      const recovered = storage.getItem(recoveryKey);
      if (recovered) {
        try {
          const parsed = JSON.parse(recovered) as unknown;
          const draft = isEditorRecoveryDraft(parsed)
            ? parsed
            : (parsed as LegacyEditorRecoveryDraft);
          const recoveredSnapshot = isEditorRecoveryDraft(draft)
            ? JSON.stringify(draft.values)
            : JSON.stringify({
                ...recoveryValues(),
                body: draft.body,
                slug: draft.slug,
                title: String(draft.metadata?.title ?? ''),
              });
          if (
            recoveredSnapshot !== serverSnapshot &&
            browserWindow.confirm('发现尚未提交的本地编辑，是否恢复？')
          ) {
            if (isEditorRecoveryDraft(draft)) {
              applyRecoveryValues(draft.values);
              if (typeof draft.expectedSha === 'string') currentSha = draft.expectedSha;
            } else {
              populate(
                draft.metadata,
                draft.body,
                draft.slug,
                typeof draft.expectedSha === 'string' ? draft.expectedSha : currentSha,
              );
            }
            initialSnapshot = serverSnapshot;
            showNotice('已恢复本地编辑', '请检查内容后保存到仓库。', 'success');
            return;
          }
          storage.removeItem(recoveryKey);
        } catch {
          storage.removeItem(recoveryKey);
        }
      }
      showNotice(
        options.isNew ? '新内容已就绪' : '已载入最新版本',
        '修改后选择保存草稿或发布。',
        'success',
      );
    } catch (error) {
      showNotice('无法加载内容', error instanceof Error ? error.message : '请刷新重试。', 'error');
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
      currentStatus.textContent =
        result.status === 'published' ? '已发布' : result.status === 'ready' ? '待发布' : '草稿';
      initialSnapshot = snapshot();
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
          : result.status === 'published'
            ? '发布已提交'
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
                    draft: action !== 'publish',
                    publicationStatus:
                      action === 'publish'
                        ? 'published'
                        : action === 'ready' || action === 'schedule'
                          ? 'ready'
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
    void save('draft');
  });
  saveButtons.forEach((button) => {
    button.addEventListener('click', () => void save(button.dataset.action));
  });
  body.addEventListener('input', renderPreview);
  form.addEventListener('input', scheduleRecovery);
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
      void save('draft');
    }
  });
  const viewButtons = [...document.querySelectorAll<HTMLElement>('.view-switch [data-view]')];
  viewButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const view = button.dataset.view;
      viewButtons.forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
      document.querySelector<HTMLElement>('[data-body-panel]')!.dataset.editorView = view;
    });
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
              const restore = document.createElement('button');
              heading.textContent = entry.message.split('\n')[0];
              meta.textContent = `${entry.author} · ${new Date(entry.date).toLocaleString('zh-CN')}`;
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
              item.append(heading, meta, restore);
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
