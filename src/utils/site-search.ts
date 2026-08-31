export type PagefindResult = {
  id: string;
  data: () => Promise<{
    url: string;
    meta?: {
      title?: string;
    };
    excerpt: string;
  }>;
};

export type PagefindModule = {
  init?: () => Promise<void>;
  options?: (options: { baseUrl?: string }) => Promise<void> | void;
  search: (query: string) => Promise<{ results: PagefindResult[] }>;
};

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const baseUrl = import.meta.env.BASE_URL || '/';
const pagefindPath = `${baseUrl.replace(/\/$/, '')}/pagefind/pagefind.js`.replace(
  /^\/pagefind/,
  '/pagefind',
);

let pagefindPromise: Promise<PagefindModule> | null = null;
const searchLayers = new WeakMap<HTMLElement, HTMLElement>();
const searchAnimationFrames = new WeakMap<HTMLElement, number>();
const searchHideTimers = new WeakMap<HTMLElement, number>();
const publicResultRoots = ['/about', '/blog', '/media', '/projects', '/tags', '/vibe'];

function getSearchSurface(root: HTMLElement) {
  return searchLayers.get(root) ?? root;
}

function querySearchSurface<T extends Element>(root: HTMLElement, selector: string) {
  return getSearchSurface(root).querySelector<T>(selector) ?? root.querySelector<T>(selector);
}

function normalizeResultUrl(url: string) {
  if (/^[a-z][a-z\d+.-]*:/iu.test(url) || url.startsWith('//')) return url;
  const normalizedBase = baseUrl.replace(/\/$/, '');

  if (!normalizedBase || normalizedBase === '/') return url;
  if (url.startsWith(`${normalizedBase}/`)) return url;
  if (url.startsWith('/')) return `${normalizedBase}${url}`;

  return `${normalizedBase}/${url}`;
}

function resolveSameOriginResultUrl(url: string) {
  try {
    const resolved = new URL(normalizeResultUrl(url), window.location.origin);
    if (!['http:', 'https:'].includes(resolved.protocol)) return null;
    if (resolved.origin !== window.location.origin) return null;
    return resolved;
  } catch {
    return null;
  }
}

function getResultPath(url: string) {
  const resolved = resolveSameOriginResultUrl(url);
  if (!resolved) return '';

  const path = resolved.pathname;
  const normalizedBase = baseUrl.replace(/\/$/, '');

  if (normalizedBase && normalizedBase !== '/') {
    if (path === normalizedBase) return '/';
    if (path.startsWith(`${normalizedBase}/`)) return path.slice(normalizedBase.length) || '/';
    return '';
  }

  return path;
}

function getResultHref(url: string) {
  const resolved = resolveSameOriginResultUrl(url);
  if (!resolved) return '#';
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

function isPublicResultUrl(url: string) {
  const resultPath = getResultPath(url);
  if (!resultPath) return false;
  const path = resultPath.replace(/\/$/, '') || '/';
  return (
    path === '/' || publicResultRoots.some((root) => path === root || path.startsWith(`${root}/`))
  );
}

function getResultKind(root: HTMLElement, url: string) {
  const path = getResultPath(url);
  const vibeRoute = root.dataset.searchRouteVibe || '/vibe';
  const projectsRoute = root.dataset.searchRouteProjects || '/projects';

  if (/^\/blog\/[^/]+\/?$/.test(path)) return root.dataset.searchKindBlogNote || 'Blog note';
  if (path.startsWith('/blog')) return root.dataset.searchKindBlogIndex || 'Blog index';
  if (path === vibeRoute || path.startsWith(`${vibeRoute}/`)) {
    return root.dataset.searchKindVibe || 'Vibe';
  }
  if (path === projectsRoute || path.startsWith(`${projectsRoute}/`)) {
    return root.dataset.searchKindProject || 'Project';
  }

  return root.dataset.searchKindPage || 'Page';
}

function getResultTitle(result: Awaited<ReturnType<PagefindResult['data']>>) {
  return result.meta?.title?.trim() || getResultPath(result.url);
}

async function loadPagefind() {
  if (!pagefindPromise) {
    pagefindPromise = import(/* @vite-ignore */ pagefindPath)
      .then(async (module: PagefindModule) => {
        await module.options?.({ baseUrl });
        await module.init?.();
        return module;
      })
      .catch((error) => {
        pagefindPromise = null;
        throw error;
      });
  }

  return pagefindPromise;
}

function setStatus(root: HTMLElement, status: string) {
  const statusNode = querySearchSurface<HTMLElement>(root, '[data-site-search-status]');
  if (statusNode) statusNode.textContent = status;
}

function setExpanded(root: HTMLElement, expanded: boolean) {
  root.dataset.searchOpen = expanded ? 'true' : 'false';
  const layer =
    searchLayers.get(root) ?? root.querySelector<HTMLElement>('[data-site-search-layer]');

  if (layer) {
    const animationFrame = searchAnimationFrames.get(layer);
    const hideTimer = searchHideTimers.get(layer);
    if (animationFrame) window.cancelAnimationFrame(animationFrame);
    if (hideTimer) window.clearTimeout(hideTimer);

    layer.inert = !expanded;
    layer.setAttribute('aria-hidden', String(!expanded));

    if (expanded) {
      layer.hidden = false;
      layer.dataset.searchOpen = 'false';
      searchAnimationFrames.set(
        layer,
        window.requestAnimationFrame(() => {
          searchAnimationFrames.set(
            layer,
            window.requestAnimationFrame(() => {
              if (root.dataset.searchOpen === 'true') layer.dataset.searchOpen = 'true';
              searchAnimationFrames.delete(layer);
            }),
          );
        }),
      );
    } else {
      layer.dataset.searchOpen = 'false';
      searchHideTimers.set(
        layer,
        window.setTimeout(() => {
          if (root.dataset.searchOpen !== 'true') layer.hidden = true;
          searchHideTimers.delete(layer);
        }, 180),
      );
    }
  }
  root
    .querySelector<HTMLButtonElement>('[data-site-search-trigger]')
    ?.setAttribute('aria-expanded', String(expanded));
}

function getFocusable(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => element.offsetParent !== null,
  );
}

function trapFocus(event: KeyboardEvent, dialog: HTMLElement) {
  if (event.key !== 'Tab') return;

  const focusable = getFocusable(dialog);
  if (focusable.length === 0) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function renderResults(root: HTMLElement, results: Awaited<ReturnType<PagefindResult['data']>>[]) {
  const list = querySearchSurface<HTMLElement>(root, '[data-site-search-results]');
  if (!list) return;

  list.replaceChildren();

  for (const result of results) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    const title = document.createElement('span');
    const meta = document.createElement('span');
    const match = document.createElement('span');
    const matchLabel = document.createElement('span');
    const excerpt = document.createElement('span');

    link.href = getResultHref(result.url);
    title.className = 'site-search-result-title';
    title.textContent = getResultTitle(result);
    meta.className = 'site-search-result-meta';
    meta.textContent = `${getResultKind(root, result.url)} - ${getResultPath(result.url)}`;
    match.className = 'site-search-result-match';
    matchLabel.className = 'site-search-result-match-label';
    matchLabel.textContent = root.dataset.searchMatchLabel || 'Matched passage';
    excerpt.className = 'site-search-result-excerpt';
    excerpt.innerHTML = result.excerpt;

    match.append(matchLabel, excerpt);
    link.append(title, meta, match);
    item.append(link);
    list.append(item);
  }
}

function debounce<T extends (...args: any[]) => void>(callback: T, delay: number) {
  let timeout: number | undefined;

  return (...args: Parameters<T>) => {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(() => callback(...args), delay);
  };
}

type InitSiteSearchOptions = {
  loadSearchIndex?: () => Promise<PagefindModule>;
};

export function initSiteSearch({ loadSearchIndex = loadPagefind }: InitSiteSearchOptions = {}) {
  for (const root of document.querySelectorAll<HTMLElement>('[data-site-search-root]')) {
    if (root.dataset.siteSearchReady === 'true') continue;
    root.dataset.siteSearchReady = 'true';

    const trigger = root.querySelector<HTMLButtonElement>('[data-site-search-trigger]');
    const dialog = root.querySelector<HTMLElement>('[data-site-search-dialog]');
    const input = root.querySelector<HTMLInputElement>('[data-site-search-input]');
    const layer = root.querySelector<HTMLElement>('[data-site-search-layer]');
    const closeButtons = root.querySelectorAll<HTMLButtonElement>('[data-site-search-close]');
    const maxResults = Number(root.dataset.searchMaxResults || 6);

    if (!trigger || !dialog || !input || !layer) continue;

    for (const orphanedLayer of document.body.querySelectorAll<HTMLElement>(
      '[data-site-search-layer]',
    )) {
      if (orphanedLayer !== layer) orphanedLayer.remove();
    }

    searchLayers.set(root, layer);
    document.body.append(layer);

    let lastFocusedElement: HTMLElement | null = null;
    let searchRequestSequence = 0;
    let activeSearchController: AbortController | null = null;

    const invalidateActiveSearch = () => {
      searchRequestSequence += 1;
      activeSearchController?.abort();
      activeSearchController = null;
    };

    const close = (restoreFocus = true) => {
      if (root.dataset.searchOpen !== 'true') return;
      invalidateActiveSearch();
      setExpanded(root, false);
      input.value = '';
      renderResults(root, []);
      setStatus(root, root.dataset.searchIdleLabel || 'Start typing to search.');
      if (restoreFocus) {
        const focusTarget = lastFocusedElement?.isConnected ? lastFocusedElement : trigger;
        focusTarget.focus();
      }
      lastFocusedElement = null;
    };

    const open = () => {
      if (root.dataset.searchOpen === 'true') {
        input.focus();
        return;
      }
      lastFocusedElement =
        document.activeElement instanceof HTMLElement && document.activeElement !== document.body
          ? document.activeElement
          : trigger;
      setExpanded(root, true);
      window.setTimeout(() => input.focus(), 30);
      void loadSearchIndex().catch(() => {
        setStatus(
          root,
          root.dataset.searchUnavailableLabel || 'Search index is not available yet.',
        );
      });
    };

    const runSearchNow = async () => {
      const query = input.value.trim();

      invalidateActiveSearch();

      if (!query) {
        renderResults(root, []);
        setStatus(root, root.dataset.searchIdleLabel || 'Start typing to search.');
        return;
      }

      const requestSequence = searchRequestSequence;
      const controller = new AbortController();
      activeSearchController = controller;
      const isCurrentRequest = () =>
        !controller.signal.aborted && requestSequence === searchRequestSequence;

      setStatus(root, root.dataset.searchLoadingLabel || 'Searching...');

      try {
        const pagefind = await loadSearchIndex();
        if (!isCurrentRequest()) return;
        const search = await pagefind.search(query);
        if (!isCurrentRequest()) return;
        const resultData = (
          await Promise.all(
            search.results
              .slice(0, Math.max(maxResults * 3, maxResults))
              .map((result) => result.data()),
          )
        )
          .filter((result) => isPublicResultUrl(result.url))
          .slice(0, maxResults);

        if (!isCurrentRequest()) return;
        renderResults(root, resultData);
        setStatus(
          root,
          resultData.length > 0
            ? `${resultData.length} result${resultData.length === 1 ? '' : 's'}`
            : root.dataset.searchEmptyLabel || 'No notes found.',
        );
      } catch {
        if (!isCurrentRequest()) return;
        renderResults(root, []);
        setStatus(
          root,
          root.dataset.searchUnavailableLabel || 'Search index is not available yet.',
        );
      } finally {
        if (isCurrentRequest()) activeSearchController = null;
      }
    };
    const runSearch = debounce(runSearchNow, 120);

    trigger.addEventListener('click', open);
    root.addEventListener('site-search:open', open);
    root.addEventListener('site-search:close', () => close());
    input.addEventListener('input', runSearch);
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;

      event.preventDefault();
      void runSearchNow();
    });

    for (const button of closeButtons) {
      button.addEventListener('click', () => close());
    }

    layer.addEventListener('click', (event) => {
      if ((event.target as Element).matches('[data-site-search-backdrop]')) close();
      if ((event.target as Element).closest('[data-site-search-results] a')) close(false);
    });
  }
}

function handleDocumentKeydown(event: KeyboardEvent) {
  const root = document.querySelector<HTMLElement>('[data-site-search-root]');
  if (!root) return;

  if (root.dataset.searchOpen === 'true') {
    if (event.key === 'Escape') {
      event.preventDefault();
      root.dispatchEvent(new CustomEvent('site-search:close'));
      return;
    }

    const dialog = querySearchSurface<HTMLElement>(root, '[data-site-search-dialog]');
    if (dialog) trapFocus(event, dialog);
  }

  const isModK = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
  if (!isModK) return;

  event.preventDefault();

  if (root.dataset.searchOpen === 'true') {
    querySearchSurface<HTMLInputElement>(root, '[data-site-search-input]')?.focus();
    return;
  }

  root.dispatchEvent(new CustomEvent('site-search:open'));
}

if (typeof document !== 'undefined') {
  initSiteSearch();
  document.addEventListener('keydown', handleDocumentKeydown);
  document.addEventListener('astro:page-load', () => initSiteSearch());
}
