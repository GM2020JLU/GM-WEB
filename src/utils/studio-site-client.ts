import { STUDIO_DEPLOYMENT_STORAGE_KEY } from './studio-deployment';

const RECOVERY_KEY = 'gm-studio-site-recovery';
const pageKeys = ['blog', 'projects', 'vibe', 'media'] as const;

type SiteResult = {
  commitSha?: string;
  deploymentPending?: boolean;
  error?: string;
  settings?: Record<string, unknown>;
  sha?: string;
};

type RecoveryDraft = {
  savedAt: string;
  sha: string;
  values: Record<string, unknown>;
};

export interface StudioSiteOptions {
  confirm?: (message: string) => boolean;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  setTimeout?: typeof globalThis.setTimeout;
}

async function responsePayload(response: Response): Promise<SiteResult> {
  try {
    return (await response.json()) as SiteResult;
  } catch {
    return { error: `服务器响应异常（HTTP ${response.status}）。` };
  }
}

function flatten(value: Record<string, unknown>, prefix = ''): Array<[string, unknown]> {
  return Object.entries(value).flatMap(([key, item]) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? flatten(item as Record<string, unknown>, `${prefix}${key}.`)
      : ([[`${prefix}${key}`, item]] as Array<[string, unknown]>),
  );
}

export function setupStudioSite(document: Document, options: StudioSiteOptions = {}) {
  const form = document.querySelector<HTMLFormElement>('[data-site-form]');
  const notice = document.querySelector<HTMLElement>('[data-notice]');
  if (!form || !notice) throw new Error('站点设置缺少必要控件。');
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!submit) throw new Error('站点设置缺少保存按钮。');
  const browserWindow = document.defaultView;
  if (!browserWindow) throw new Error('站点设置需要浏览器环境。');
  const request = options.fetch ?? globalThis.fetch;
  const confirmAction =
    options.confirm ?? ((value: string) => browserWindow.confirm?.(value) ?? false);
  const defer = options.setTimeout ?? globalThis.setTimeout;
  const storage = browserWindow.localStorage;
  let currentSha = '';
  let initialSnapshot = '';
  let saving = false;
  let recoveryRevision = 0;
  let staleRecovery: RecoveryDraft | undefined;

  const field = (name: string) =>
    form.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      `[name="${name}"]`,
    );
  const value = (name: string) => field(name)?.value.trim() ?? '';

  const collect = () => ({
    site: {
      title: value('site.title'),
      description: value('site.description'),
      pageTitle: value('site.pageTitle'),
      pageDescription: value('site.pageDescription'),
      footerNote: value('site.footerNote'),
    },
    theme: { palette: value('theme.palette') },
    profile: {
      name: value('profile.name'),
      role: value('profile.role'),
      email: value('profile.email'),
      avatar: value('profile.avatar'),
    },
    home: {
      introTitle: value('home.introTitle'),
      introName: value('home.introName'),
      introBody: value('home.introBody'),
      focus: value('home.focus'),
      quote: value('home.quote'),
    },
    pages: Object.fromEntries(
      pageKeys.map((key) => [
        key,
        {
          title: value(`pages.${key}.title`),
          subtitle: value(`pages.${key}.subtitle`),
          note: value(`pages.${key}.note`),
        },
      ]),
    ),
  });

  const populate = (settings: Record<string, unknown>) => {
    flatten(settings).forEach(([name, item]) => {
      const input = field(name);
      if (input) input.value = String(item ?? '');
    });
  };

  const snapshot = () => JSON.stringify(collect());
  const isDirty = () => Boolean(initialSnapshot && snapshot() !== initialSnapshot);

  const message = (title: string, detail: string, kind = '') => {
    notice.className = `notice ${kind}`.trim();
    notice.innerHTML = '<div><strong></strong><small></small></div>';
    notice.querySelector('strong')!.textContent = title;
    notice.querySelector('small')!.textContent = detail;
    notice.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  };

  const appendAction = (label: string, action: () => void) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', action);
    notice.append(button);
  };

  const appendLink = (label: string, href: string) => {
    const link = document.createElement('a');
    link.href = href;
    link.textContent = label;
    notice.append(link);
  };

  const renderPreview = () => {
    const palette = value('theme.palette');
    if (palette) document.documentElement.dataset.palette = palette;
    const avatar = document.querySelector<HTMLImageElement>('[data-avatar-preview]');
    const avatarValue = value('profile.avatar');
    if (avatar) {
      try {
        const url = new URL(avatarValue, browserWindow.location.origin);
        avatar.hidden = !['http:', 'https:'].includes(url.protocol);
        if (!avatar.hidden) avatar.src = url.href;
      } catch {
        avatar.hidden = true;
      }
    }
    const swatch = document.querySelector<HTMLElement>('[data-palette-preview]');
    const paletteSelect = form.querySelector<HTMLSelectElement>('select[name="theme.palette"]');
    if (swatch) swatch.textContent = paletteSelect?.selectedOptions[0]?.textContent ?? '';
  };

  const renderDirty = () => {
    const state = document.querySelector<HTMLElement>('[data-save-state]');
    if (!state) return;
    state.textContent = isDirty() ? '有未保存修改 · 已在本机暂存' : '所有修改均已保存';
    state.dataset.dirty = String(isDirty());
  };

  const persistRecovery = () => {
    if (!currentSha || (!isDirty() && !staleRecovery)) {
      storage.removeItem(RECOVERY_KEY);
      return;
    }
    if (!isDirty() && staleRecovery) return;
    storage.setItem(
      RECOVERY_KEY,
      JSON.stringify({
        savedAt: new Date().toISOString(),
        sha: currentSha,
        values: collect(),
      } satisfies RecoveryDraft),
    );
    staleRecovery = undefined;
  };

  const scheduleRecovery = () => {
    renderDirty();
    renderPreview();
    const revision = ++recoveryRevision;
    defer(() => {
      if (revision === recoveryRevision) persistRecovery();
    }, 250);
  };

  const setLoading = (loading: boolean) => {
    form.inert = loading;
    form.setAttribute('aria-busy', String(loading));
    submit.disabled = loading || !currentSha;
  };

  const load = async () => {
    setLoading(true);
    message('正在读取设置', '正在载入配置，请稍候。');
    try {
      const response = await request('/api/studio/site');
      const result = await responsePayload(response);
      if (!response.ok || !result.settings || typeof result.sha !== 'string') {
        throw new Error(result.error || '请刷新重试。');
      }
      populate(result.settings);
      currentSha = result.sha;
      initialSnapshot = snapshot();
      const recovered = storage.getItem(RECOVERY_KEY);
      if (recovered) {
        try {
          const draft = JSON.parse(recovered) as RecoveryDraft;
          if (
            draft.sha === currentSha &&
            draft.values &&
            JSON.stringify(draft.values) !== initialSnapshot &&
            confirmAction('发现尚未保存的站点设置，是否恢复？')
          ) {
            populate(draft.values);
            staleRecovery = undefined;
            message('已恢复本地修改', '请检查设置后保存到内容仓库。', 'success');
          } else if (draft.sha !== currentSha) {
            staleRecovery = draft;
            message(
              '设置已在其他位置更新',
              '最新配置已载入，旧的本地暂存仍保留，可手动恢复后对比。',
              'success',
            );
            appendAction('恢复旧修改', () => {
              if (!staleRecovery || !confirmAction('恢复后请仔细对比最新配置，确定继续吗？'))
                return;
              populate(staleRecovery.values);
              staleRecovery = undefined;
              renderPreview();
              renderDirty();
              persistRecovery();
              message('已恢复旧修改', '已保留服务器最新版本号，请对比后再保存。', 'success');
            });
            appendAction('放弃旧副本', () => {
              staleRecovery = undefined;
              storage.removeItem(RECOVERY_KEY);
              message('旧副本已放弃', '当前显示的是服务器最新配置。', 'success');
            });
          } else {
            storage.removeItem(RECOVERY_KEY);
            message('设置已载入', '修改后保存，线上页面会自动重新构建。', 'success');
          }
        } catch {
          storage.removeItem(RECOVERY_KEY);
          message('设置已载入', '已忽略损坏的本地暂存。', 'success');
        }
      } else {
        message('设置已载入', '修改后保存，线上页面会自动重新构建。', 'success');
      }
      renderPreview();
      renderDirty();
    } catch (error) {
      currentSha = '';
      message('无法读取设置', error instanceof Error ? error.message : '网络连接异常。', 'error');
      appendAction('重新载入', () => void load());
    } finally {
      setLoading(false);
    }
  };

  form.addEventListener('input', scheduleRecovery);
  form.addEventListener('change', scheduleRecovery);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving || !form.reportValidity()) return;
    if (!currentSha) {
      message('无法保存', '请先重新载入最新站点设置。', 'error');
      appendAction('重新载入', () => void load());
      return;
    }
    saving = true;
    submit.disabled = true;
    form.setAttribute('aria-busy', 'true');
    const outbound = collect();
    const outboundSnapshot = JSON.stringify(outbound);
    message('正在保存', '正在写入站点配置。');
    try {
      const response = await request('/api/studio/site', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedSha: currentSha, ...outbound }),
      });
      const result = await responsePayload(response);
      if (!response.ok) throw new Error(result.error || '请稍后重试。');
      if (typeof result.sha !== 'string') throw new Error('服务器未返回最新设置版本。');
      currentSha = result.sha;
      initialSnapshot = outboundSnapshot;
      if (result.commitSha) {
        storage.setItem(
          STUDIO_DEPLOYMENT_STORAGE_KEY,
          JSON.stringify({
            targetSha: result.commitSha,
            title: '站点设置',
            startedAt: new Date().toISOString(),
            publicUrl: '/',
          }),
        );
      }
      if (snapshot() === outboundSnapshot) {
        storage.removeItem(RECOVERY_KEY);
        message(
          '保存成功',
          result.deploymentPending ? '已经提交，可继续查看网站上线进度。' : '本地配置已经更新。',
          'success',
        );
      } else {
        persistRecovery();
        message('已保存提交时的版本', '保存期间产生的新修改仍在本机暂存，请再次保存。', 'success');
      }
      appendLink(
        result.deploymentPending ? '查看上线进度' : '打开网站',
        result.deploymentPending ? '/studio' : '/',
      );
      renderDirty();
    } catch (error) {
      persistRecovery();
      message('保存失败', error instanceof Error ? error.message : '网络连接异常。', 'error');
      if (error instanceof Error && error.message.includes('修改')) {
        appendAction('载入最新版本', () => void load());
      }
    } finally {
      saving = false;
      submit.disabled = !currentSha;
      form.setAttribute('aria-busy', 'false');
    }
  });

  browserWindow.addEventListener('pagehide', persistRecovery);
  browserWindow.addEventListener('beforeunload', (event) => {
    if (isDirty()) event.preventDefault();
  });
  void load();
  return { load };
}
