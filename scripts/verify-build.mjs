import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

import { getBuildOutputDirectory } from './build-output.mjs';

const root = process.cwd();
const dist = getBuildOutputDirectory(root);
const vercelOutput = join(root, '.vercel', 'output');
const vercelStatic = join(vercelOutput, 'static');
const errors = [];

function fail(message) {
  errors.push(message);
}

function walk(directory, predicate = () => true) {
  if (!existsSync(directory)) return [];

  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute, predicate));
    if (entry.isFile() && predicate(absolute)) files.push(absolute);
  }
  return files;
}

function resolvePublicPath(value) {
  const withoutSuffix = value.split('#')[0].split('?')[0];
  let decoded;

  try {
    decoded = decodeURI(withoutSuffix);
  } catch {
    fail(`无法解码站内链接：${value}`);
    return null;
  }

  if (!decoded || !decoded.startsWith('/') || decoded.startsWith('//')) return null;
  if (decoded === '/keystatic' || decoded.startsWith('/keystatic/')) return null;

  if (decoded === '/') return join(dist, 'index.html');
  if (decoded.endsWith('/')) return join(dist, decoded, 'index.html');
  if (extname(decoded)) return join(dist, decoded);
  return join(dist, decoded, 'index.html');
}

const requiredFiles = [
  'index.html',
  '404.html',
  'about/index.html',
  'blog/index.html',
  'blog/rebuild-personal-site/index.html',
  'projects/index.html',
  'projects/personal-site/index.html',
  'vibe/index.html',
  'studio/index.html',
  'preview/about/index.html',
  'preview/blog/casdcv/index.html',
  'preview/render/blog/casdcv/index.html',
  'preview/vibe/2026-08-23-new-site/index.html',
  'preview/render/vibe/2026-08-23-new-site/index.html',
  'rss.xml',
  'robots.txt',
  'sitemap-index.xml',
  'pagefind/pagefind.js',
  'favicon.svg',
  'manifest.json',
  'og-card.png',
  'avatar/goumin-avatar-352.webp',
  '.well-known/security.txt',
];

for (const file of requiredFiles) {
  if (!existsSync(join(dist, file))) fail(`缺少构建产物：${file}`);
}

const htmlFiles = walk(dist, (file) => file.endsWith('.html'));
const upstreamMarkers = [
  'dodolalorc',
  'hello@navfolio.site',
  'astro.navfolio.site',
  'A Cat Developer',
  '123456789',
];
const untranslatedUiMarkers = [
  'Close image preview',
  'Open website',
  'Open GitHub profile',
  'Close navigation menu',
  'Open navigation menu',
  '>Reading time<',
  '>Was this helpful?<',
];

for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');
  const relative = file.slice(dist.length + 1);

  if (!html.includes('<html lang="zh-CN"')) fail(`${relative} 未使用 zh-CN`);
  if (!html.includes('<meta name="description"')) fail(`${relative} 缺少 description`);
  if (!html.includes('<link rel="canonical"')) fail(`${relative} 缺少 canonical`);
  if (!html.includes('application/ld+json')) fail(`${relative} 缺少结构化数据`);

  for (const marker of upstreamMarkers) {
    if (html.toLowerCase().includes(marker.toLowerCase())) {
      fail(`${relative} 泄漏了模板标识：${marker}`);
    }
  }

  for (const marker of untranslatedUiMarkers) {
    if (html.includes(marker)) fail(`${relative} 残留英文界面文案：${marker}`);
  }

  for (const match of html.matchAll(/(?:href|src)="(\/[^"]*)"/g)) {
    const target = resolvePublicPath(match[1]);
    if (target && !existsSync(target)) fail(`${relative} 存在断链：${match[1]}`);
  }
}

const home = readFileSync(join(dist, 'index.html'), 'utf8');
for (const marker of [
  'Gou Min',
  '嵌入式系统工程师',
  '文章',
  '项目',
  '随记',
  'Bootloader',
  '查看项目案例',
  '邮件交流',
]) {
  if (!home.includes(marker)) fail(`首页缺少关键内容：${marker}`);
}
if (home.includes('data-navfolio-full-font-warmup')) fail('首页仍在预取完整中文字体');
if (home.includes('href="/media"')) fail('首页仍展示空的书影音入口');
if (!home.includes('https://goumin.work/og-card.png')) fail('首页未使用自定义 OG 图');
if (!home.includes('https://goumin.work/avatar/goumin-avatar-352.webp')) {
  fail('首页未使用本地优化头像');
}
if (home.includes('avatars.githubusercontent.com')) fail('首页仍依赖 GitHub 头像');
if (home.includes('keystatic-page') || home.includes('react-dom')) {
  fail('公开首页意外加载了 Keystatic/React 后台资源');
}
if (existsSync(join(dist, 'blog/casdcv/index.html'))) fail('草稿文章意外出现在公开路由');

const studio = readFileSync(join(dist, 'studio/index.html'), 'utf8');
for (const marker of [
  '今天写点什么？',
  '打开内容编辑器',
  '新建内容',
  '三步发布',
  '继续编辑',
  'data-deploy-label',
  'data-search',
  '建议完善',
  '历史<span',
  '/keystatic/branch/main/collection/blog/create',
  '/keystatic/branch/main/collection/media/create',
]) {
  if (!studio.includes(marker)) fail(`内容工作台缺少：${marker}`);
}
if (!studio.includes('noindex,nofollow,noarchive')) fail('内容工作台缺少 noindex');

const project = readFileSync(join(dist, 'projects/personal-site/index.html'), 'utf8');
for (const marker of ['项目概览', '我的角色', '项目周期', '关键成果', '独立产品设计']) {
  if (!project.includes(marker)) fail(`项目案例缺少证据内容：${marker}`);
}
if (!project.includes('问题与目标') || !project.includes('核心取舍')) {
  fail('项目案例缺少问题与决策过程');
}

const preview = readFileSync(join(dist, 'preview/blog/casdcv/index.html'), 'utf8');
for (const marker of [
  '页面预览',
  '桌面',
  '平板',
  '手机',
  '/preview/render/blog/casdcv',
  '/keystatic/branch/main/collection/blog/item/casdcv',
]) {
  if (!preview.includes(marker)) fail(`预览工作台缺少：${marker}`);
}

const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
if (manifest.name !== 'Gou Min 的个人站') fail('Web App Manifest 名称不正确');
if (manifest.lang !== 'zh-CN') fail('Web App Manifest 未声明 zh-CN');

const sitemapIndex = readFileSync(join(dist, 'sitemap-index.xml'), 'utf8');
if (!sitemapIndex.includes('https://goumin.work/')) fail('Sitemap 未指向生产域名');

const rss = readFileSync(join(dist, 'rss.xml'), 'utf8');
if (!rss.includes('我为什么重新做了个人站')) fail('RSS 缺少已发布文章');

const robots = readFileSync(join(dist, 'robots.txt'), 'utf8');
for (const route of ['/keystatic/', '/api/keystatic/', '/studio', '/preview/']) {
  if (!robots.includes(`Disallow: ${route}`)) fail(`robots.txt 未禁止索引 ${route}`);
}

const vercelRequiredFiles = [
  'config.json',
  'functions/_render.func/.vc-config.json',
  'static/index.html',
  'static/pagefind/pagefind.js',
  'static/robots.txt',
];
for (const file of vercelRequiredFiles) {
  if (!existsSync(join(vercelOutput, file))) fail(`Vercel 产物缺少：${file}`);
}

if (existsSync(join(vercelOutput, 'config.json'))) {
  const vercelConfig = readFileSync(join(vercelOutput, 'config.json'), 'utf8');
  for (const route of ['/keystatic', '/api/keystatic']) {
    if (!vercelConfig.includes(route)) fail(`Vercel 未配置后台动态路由：${route}`);
  }
}

const vercelSourceConfig = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
for (const route of ['/studio', '/preview/(.*)']) {
  const header = vercelSourceConfig.headers.find((item) => item.source === route);
  if (!header) fail(`Vercel 缺少私有页面响应头：${route}`);
  if (!header?.headers.some((item) => item.key === 'X-Robots-Tag')) {
    fail(`Vercel 私有页面缺少 X-Robots-Tag：${route}`);
  }
}
const globalHeaders = vercelSourceConfig.headers.find((item) => item.source === '/(.*)');
if (
  !globalHeaders?.headers.some(
    (item) => item.key === 'X-Frame-Options' && item.value === 'SAMEORIGIN',
  )
) {
  fail('真实预览需要 X-Frame-Options: SAMEORIGIN');
}

if (existsSync(vercelStatic)) {
  for (const removed of ['audio', 'images', 'fonts/ChillRoundM.ttf']) {
    if (existsSync(join(vercelStatic, removed))) fail(`Vercel 产物仍包含已精简资源：${removed}`);
  }
}

const sizeBudgets = [
  ['og-card.png', 200 * 1024],
  ['fonts/LXGWWenKai-Regular-content-subset-ui-subset.woff2', 500 * 1024],
  ['fonts/LXGWWenKai-Regular-content-subset.woff2', 500 * 1024],
];

for (const [file, maxBytes] of sizeBudgets) {
  const absolute = join(dist, file);
  if (!existsSync(absolute)) continue;
  const size = statSync(absolute).size;
  if (size > maxBytes) fail(`${file} 超出体积预算：${size} > ${maxBytes}`);
}

if (errors.length > 0) {
  console.error(`\n构建验证失败（${errors.length} 项）：`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `构建验证通过：${htmlFiles.length} 个 HTML 页面，${requiredFiles.length} 个必要产物，站内链接全部有效。`,
);
