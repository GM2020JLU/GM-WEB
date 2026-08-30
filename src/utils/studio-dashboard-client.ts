import { matchesContentFilters } from './content-metrics';
import {
  deploymentCopy,
  readPendingDeployment,
  STUDIO_DEPLOYMENT_STORAGE_KEY,
  type PendingStudioDeployment,
  type StudioDeploymentState,
} from './studio-deployment';

type BulkResult = {
  commitSha?: string;
  deploymentPending?: boolean;
  error?: string;
  ok?: boolean;
  partial?: boolean;
  status?: string;
  updated?: number;
  updatedItems?: Array<{ collection: string; slug: string }>;
};

export interface StudioDashboardOptions {
  confirm?: (message: string) => boolean;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  reload?: () => void;
  setTimeout?: typeof globalThis.setTimeout;
}

async function json(response: Response) {
  try {
    return (await response.json()) as BulkResult & {
      deployment?: StudioDeploymentState;
    };
  } catch {
    return { error: `服务器响应异常（HTTP ${response.status}）。` };
  }
}

export function setupStudioDashboard(document: Document, options: StudioDashboardOptions = {}) {
  const browserWindow = document.defaultView;
  if (!browserWindow) throw new Error('内容总览需要浏览器环境。');
  const request = options.fetch ?? globalThis.fetch;
  const confirmAction =
    options.confirm ?? ((value: string) => browserWindow.confirm?.(value) ?? false);
  const reload = options.reload ?? (() => browserWindow.location.reload());
  const defer = options.setTimeout ?? globalThis.setTimeout;
  const storage = browserWindow.localStorage;
  const filters = [...document.querySelectorAll<HTMLElement>('[data-filter]')];
  const rows = [...document.querySelectorAll<HTMLElement>('[data-row]')];
  const search = document.querySelector<HTMLInputElement>('[data-search]');
  const type = document.querySelector<HTMLSelectElement>('[data-type-filter]');
  const empty = document.querySelector<HTMLElement>('[data-empty]');
  const selected = [...document.querySelectorAll<HTMLInputElement>('[data-select-item]')];
  const bulk = document.querySelector<HTMLElement>('[data-bulk-bar]');
  const count = document.querySelector<HTMLElement>('[data-selected-count]');
  const selectionAnnouncement = document.querySelector<HTMLElement>(
    '[data-selection-announcement]',
  );
  const feedback = document.querySelector<HTMLElement>('[data-bulk-feedback]');
  const bulkButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-bulk-action]')];
  const requestedStatus = new URL(browserWindow.location.href).searchParams.get('status');
  let active = filters.some((filter) => filter.dataset.filter === requestedStatus)
    ? (requestedStatus ?? 'all')
    : 'all';
  filters.forEach((filter) =>
    filter.setAttribute('aria-pressed', String(filter.dataset.filter === active)),
  );

  const selectedVisibleItems = () =>
    selected.flatMap((input) => {
      const row = input.closest<HTMLElement>('[data-row]');
      return input.checked && !row?.hidden
        ? [
            {
              collection: input.dataset.collection ?? '',
              expectedUpdatedDate: input.dataset.revision || undefined,
              slug: input.dataset.slug ?? '',
            },
          ]
        : [];
    });

  let lastSelectedTotal = 0;
  const updateSelection = (announce = false) => {
    const total = selectedVisibleItems().length;
    if (bulk) bulk.hidden = total === 0;
    if (count) count.textContent = String(total);
    if (announce && selectionAnnouncement && total !== lastSelectedTotal) {
      selectionAnnouncement.textContent = total
        ? `已选择 ${total} 条内容。批量操作已显示在内容列表上方。`
        : '已取消全部选择，批量操作已收起。';
    }
    lastSelectedTotal = total;
  };

  const applyFilters = (announceSelection = false) => {
    let visible = 0;
    for (const row of rows) {
      const show = matchesContentFilters(
        {
          status: row.dataset.status,
          type: row.dataset.type,
          health: row.dataset.health,
          text: row.textContent ?? '',
        },
        {
          status: active,
          type: type?.value ?? 'all',
          query: search?.value.trim().toLocaleLowerCase('zh-CN') ?? '',
        },
      );
      row.hidden = !show;
      if (!show) {
        const checkbox = row.querySelector<HTMLInputElement>('[data-select-item]');
        if (checkbox) checkbox.checked = false;
      } else {
        visible++;
      }
    }
    if (empty) empty.hidden = visible > 0;
    updateSelection(announceSelection);
  };

  const showFeedback = (title: string, detail: string, kind = '') => {
    if (!feedback) return;
    feedback.hidden = false;
    feedback.className = `bulk-feedback ${kind}`.trim();
    feedback.innerHTML = '<div><strong></strong><small></small></div>';
    feedback.querySelector('strong')!.textContent = title;
    feedback.querySelector('small')!.textContent = detail;
    feedback.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  };

  const setBulkBusy = (busy: boolean) => {
    bulk?.setAttribute('aria-busy', String(busy));
    bulkButtons.forEach((button) => (button.disabled = busy));
    selected.forEach((input) => (input.disabled = busy));
  };

  filters.forEach((button) =>
    button.addEventListener('click', () => {
      active = button.dataset.filter ?? 'all';
      filters.forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
      applyFilters(true);
    }),
  );
  search?.addEventListener('input', () => applyFilters(true));
  type?.addEventListener('change', () => applyFilters(true));
  selected.forEach((input) => input.addEventListener('change', () => updateSelection(true)));

  const actionLabels: Record<string, string> = {
    draft: '转为草稿',
    ready: '设为待发布',
    publish: '发布',
    unpublish: '撤回发布',
  };
  bulkButtons.forEach((button) =>
    button.addEventListener('click', async () => {
      const items = selectedVisibleItems();
      const action = button.dataset.bulkAction ?? '';
      const actionLabel = actionLabels[action] ?? '更新';
      if (!items.length || !confirmAction(`确定${actionLabel}这 ${items.length} 条内容吗？`))
        return;
      setBulkBusy(true);
      showFeedback('正在批量更新', `${items.length} 条内容正在处理，请不要关闭页面。`);
      try {
        const response = await request('/api/studio/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, items }),
        });
        const result = await json(response);
        if (result.commitSha && result.deploymentPending) {
          storage.setItem(
            STUDIO_DEPLOYMENT_STORAGE_KEY,
            JSON.stringify({
              targetSha: result.commitSha,
              title: `${items.length} 条内容`,
              startedAt: new Date().toISOString(),
            }),
          );
        }
        if (!response.ok || result.ok === false) {
          showFeedback(
            result.partial ? '部分内容已更新' : '批量操作失败',
            result.error || '请检查网络后重试。',
            'error',
          );
          if (result.partial && feedback) {
            const refresh = document.createElement('button');
            refresh.type = 'button';
            refresh.textContent = '刷新列表';
            refresh.addEventListener('click', reload);
            feedback.append(refresh);
          }
          return;
        }
        showFeedback(
          '批量操作完成',
          `已${actionLabel} ${result.updated ?? items.length} 条内容。`,
          'success',
        );
        reload();
      } catch (error) {
        showFeedback(
          '批量操作失败',
          error instanceof Error ? error.message : '网络连接异常，请重试。',
          'error',
        );
      } finally {
        setBulkBusy(false);
      }
    }),
  );

  const deployment = document.querySelector<HTMLElement>('[data-deployment]');
  const deploymentTitle = document.querySelector<HTMLElement>('[data-deployment-title]');
  const deploymentDetail = document.querySelector<HTMLElement>('[data-deployment-detail]');
  const deploymentTrack = document.querySelector<HTMLElement>('[data-deployment-track]');
  const deploymentProgress = document.querySelector<HTMLElement>('[data-deployment-progress]');
  const deploymentLink = document.querySelector<HTMLAnchorElement>('[data-deployment-link]');
  let consecutivePollFailures = 0;

  const pollDeployment = async (pending: PendingStudioDeployment) => {
    if (!deployment) return;
    deployment.dataset.phase = 'submitted';
    if (deploymentTrack) deploymentTrack.hidden = false;
    try {
      const response = await request(
        `/api/studio/deployment?sha=${encodeURIComponent(pending.targetSha)}`,
      );
      const result = await json(response);
      if (!response.ok || !result.deployment) throw new Error(result.error || '无法读取部署状态。');
      consecutivePollFailures = 0;
      const copy = deploymentCopy(result.deployment);
      deployment.dataset.phase = result.deployment.phase;
      if (deploymentTitle) deploymentTitle.textContent = copy.title;
      if (deploymentDetail) deploymentDetail.textContent = copy.detail;
      if (deploymentProgress) deploymentProgress.style.width = `${copy.progress}%`;
      if (result.deployment.phase === 'ready') {
        storage.removeItem(STUDIO_DEPLOYMENT_STORAGE_KEY);
        if (deploymentLink && pending.publicUrl) {
          deploymentLink.href = pending.publicUrl;
          deploymentLink.hidden = false;
        }
        return;
      }
      if (result.deployment.phase === 'error') {
        if (deploymentLink && result.deployment.logUrl) {
          deploymentLink.href = result.deployment.logUrl;
          deploymentLink.textContent = '查看失败原因';
          deploymentLink.hidden = false;
        }
        return;
      }
      defer(() => void pollDeployment(pending), 3000);
    } catch {
      consecutivePollFailures++;
      if (deploymentTitle) deploymentTitle.textContent = '暂时无法读取部署状态';
      if (deploymentDetail) {
        deploymentDetail.textContent =
          consecutivePollFailures >= 5
            ? '内容已经保存，请稍后刷新页面重新查看。'
            : '内容已经保存，将自动重试。';
      }
      if (consecutivePollFailures < 5) {
        defer(() => void pollDeployment(pending), 6000);
      }
    }
  };

  applyFilters();
  const pending = readPendingDeployment(storage);
  if (pending) void pollDeployment(pending);
}
