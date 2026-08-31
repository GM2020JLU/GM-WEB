import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getBuildOutputDirectory } from './build-output.mjs';

const privateRouteSource =
  '^/(?:studio(?:/.*)?|api/studio(?:/.*)?|keystatic(?:/.*)?|api/keystatic(?:/.*)?|preview(?:/.*)?)$';
const privateStaticRoots = new Set(['studio', 'preview', 'keystatic', 'api']);
const studioRedirectSources = new Set(['^/studio/?$', '^/studio/(.*)$']);
const textExtensions = new Set(['.css', '.html', '.js', '.json', '.mjs', '.svg', '.xml']);

function walk(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

function removePrivateStaticRoutes(target) {
  for (const root of privateStaticRoots) {
    rmSync(join(target, root), { recursive: true, force: true });
  }
}

function studioRedirectRoutes() {
  const configured = process.env.STUDIO_PUBLIC_ORIGIN?.trim() || 'https://studio.goumin.work';
  const origin = new URL(configured);
  if (origin.protocol !== 'https:' || origin.origin !== configured.replace(/\/$/u, '')) {
    throw new Error('STUDIO_PUBLIC_ORIGIN 必须是无路径的 HTTPS origin。');
  }
  return [
    { src: '^/studio/?$', status: 307, headers: { Location: `${origin.origin}/` } },
    {
      src: '^/studio/(.*)$',
      status: 307,
      headers: { Location: `${origin.origin}/studio/$1` },
    },
  ];
}

function pruneUnreachableAstroAssets(target) {
  const assets = join(target, '_astro');
  if (!existsSync(assets)) return { kept: 0, removed: 0 };
  const assetFiles = walk(assets);
  const byRelativePath = new Map(
    assetFiles.map((file) => [relative(assets, file).split(sep).join('/'), file]),
  );
  const reachable = new Set();
  const scan = (content) => {
    for (const [name, file] of byRelativePath) {
      const basename = name.split('/').at(-1);
      if (
        content.includes(`/_astro/${name}`) ||
        content.includes(`./${name}`) ||
        (basename && content.includes(basename))
      ) {
        reachable.add(file);
      }
    }
  };
  for (const file of walk(target)) {
    if (file.startsWith(`${assets}${sep}`) || !textExtensions.has(extname(file))) continue;
    const info = statSync(file);
    if (info.size <= 4 * 1024 * 1024) scan(readFileSync(file, 'utf8'));
  }

  let previousSize = -1;
  while (previousSize !== reachable.size) {
    previousSize = reachable.size;
    for (const file of [...reachable]) {
      if (!textExtensions.has(extname(file)) || statSync(file).size > 4 * 1024 * 1024) continue;
      scan(readFileSync(file, 'utf8'));
    }
  }
  for (const file of assetFiles) {
    if (!reachable.has(file)) rmSync(file, { force: true });
  }
  return { kept: reachable.size, removed: assetFiles.length - reachable.size };
}

export function createPublicVercelOutput(root = process.cwd()) {
  const vercelOutput = join(root, '.vercel', 'output');
  const vercelConfig = join(vercelOutput, 'config.json');
  if (!existsSync(vercelConfig)) {
    return { skipped: true };
  }

  const config = JSON.parse(readFileSync(vercelConfig, 'utf8'));
  if (config.version !== 3) throw new Error('拒绝覆盖未知格式的 Vercel Build Output。');
  const routes = Array.isArray(config.routes) ? config.routes : [];
  config.routes = [
    ...studioRedirectRoutes(),
    { src: privateRouteSource, dest: '/404.html', status: 404 },
    ...routes.filter(
      (route) =>
        route?.src !== privateRouteSource &&
        !studioRedirectSources.has(route?.src) &&
        route?.dest !== '_render' &&
        !String(route?.dest || '').includes('_render'),
    ),
  ];
  writeFileSync(vercelConfig, `${JSON.stringify(config, null, 2)}\n`);

  const source = getBuildOutputDirectory(root);
  const target = join(vercelOutput, 'static');
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
  removePrivateStaticRoutes(target);
  const assets = pruneUnreachableAstroAssets(target);

  // The public deployment has no dynamic authoring surface. Removing the actual
  // bundles (not merely denying routes) prevents direct download and cuts ~65 MB.
  rmSync(join(vercelOutput, 'functions'), { recursive: true, force: true });
  rmSync(join(vercelOutput, '_functions'), { recursive: true, force: true });
  return { assets, skipped: false };
}

const invokedPath = process.argv[1]
  ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
  : false;
if (invokedPath) {
  const result = createPublicVercelOutput();
  if (result.skipped) console.log('未检测到 Vercel Build Output，跳过同步。');
  else {
    console.log(
      `已生成纯静态公共产物：保留 ${result.assets.kept} 个可达资源，移除 ${result.assets.removed} 个后台资源。`,
    );
  }
}

export const vercelOutputInternals = {
  privateRouteSource,
  studioRedirectRoutes,
  pruneUnreachableAstroAssets,
  removePrivateStaticRoutes,
};
