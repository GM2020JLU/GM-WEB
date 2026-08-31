import { relative, sep } from 'node:path';

/**
 * Public, indexable sections. Keeping this list explicit makes new private
 * surfaces fail closed in both Pagefind and the sitemap.
 */
export const PUBLIC_ROUTE_ROOTS = Object.freeze([
  '/about',
  '/blog',
  '/media',
  '/projects',
  '/tags',
  '/vibe',
]);

function normalizeBasePath(basePath = '/') {
  const value = `/${String(basePath).trim()}`.replace(/\/{2,}/gu, '/').replace(/\/$/u, '');
  return value === '' ? '/' : value;
}

export function normalizeRoutePath(value, basePath = '/') {
  let pathname;

  try {
    pathname = new URL(String(value), 'https://navfolio.invalid').pathname;
    pathname = decodeURI(pathname);
  } catch {
    return null;
  }

  const normalizedBase = normalizeBasePath(basePath);
  if (normalizedBase !== '/') {
    if (pathname === normalizedBase) pathname = '/';
    else if (pathname.startsWith(`${normalizedBase}/`))
      pathname = pathname.slice(normalizedBase.length);
    else return null;
  }

  const normalizedPath = `/${pathname}`.replace(/\/{2,}/gu, '/');
  return normalizedPath === '/' ? '/' : normalizedPath.replace(/\/$/u, '');
}

export function isPublicPageRoute(value, options = {}) {
  const pathname = normalizeRoutePath(value, options.basePath);
  if (!pathname) return false;
  if (pathname === '/') return true;

  return PUBLIC_ROUTE_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}

export function htmlFileToRoute(file, outputDirectory) {
  const path = relative(outputDirectory, file).split(sep).join('/');
  if (path === 'index.html') return '/';
  if (path.endsWith('/index.html')) return `/${path.slice(0, -'index.html'.length)}`;
  if (path.endsWith('.html')) return `/${path.slice(0, -'.html'.length)}`;
  return null;
}

export function isPublicHtmlFile(file, outputDirectory) {
  const route = htmlFileToRoute(file, outputDirectory);
  return route !== null && isPublicPageRoute(route);
}

/**
 * Ensure the first semantic main landmark is also a keyboard-focusable skip-link
 * target. Upstream page packages own a few public routes, so this final-output
 * normalization keeps their generated HTML accessible without patching
 * node_modules. Existing IDs are deliberately left alone so a bad upstream
 * contract fails verification instead of being silently overwritten.
 */
export function ensureMainContentTarget(html) {
  const openingTag = /<main\b[^>]*>/iu.exec(html);
  if (!openingTag) return html;

  let normalizedTag = openingTag[0];
  const hasAnyId = /\bid\s*=/iu.test(normalizedTag);
  const hasTargetId = /\bid\s*=\s*(["'])main-content\1/iu.test(normalizedTag);

  if (!hasTargetId) {
    if (hasAnyId) return html;
    normalizedTag = normalizedTag.replace(/^<main\b/iu, '<main id="main-content"');
  }

  if (!/\btabindex\s*=\s*(["'])-1\1/iu.test(normalizedTag)) {
    normalizedTag = normalizedTag.replace(/^<main\b/iu, '<main tabindex="-1"');
  }

  if (normalizedTag === openingTag[0]) return html;

  const start = openingTag.index;
  const end = start + openingTag[0].length;
  return `${html.slice(0, start)}${normalizedTag}${html.slice(end)}`;
}
