import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getBuildOutputDirectory } from './build-output.mjs';

const root = process.cwd();
const vercelOutput = join(root, '.vercel', 'output');
const vercelConfig = join(vercelOutput, 'config.json');

if (!existsSync(vercelConfig)) {
  console.log('未检测到 Vercel Build Output，跳过同步。');
  process.exit(0);
}

const config = JSON.parse(readFileSync(vercelConfig, 'utf8'));
if (config.version !== 3) {
  throw new Error('拒绝覆盖未知格式的 Vercel Build Output。');
}

// The public deployment only serves the published website. Studio remains available from
// the Mac through its private Tailscale gateway, so deny every authoring route before the
// filesystem and function routes can match it.
const privateRouteSource =
  '^/(?:studio(?:/.*)?|api/studio(?:/.*)?|keystatic(?:/.*)?|api/keystatic(?:/.*)?|preview(?:/.*)?)$';
const routes = Array.isArray(config.routes) ? config.routes : [];
config.routes = [
  { src: privateRouteSource, dest: '/404.html', status: 404 },
  ...routes.filter((route) => route?.src !== privateRouteSource),
];
writeFileSync(vercelConfig, `${JSON.stringify(config, null, 2)}\n`);

const source = getBuildOutputDirectory(root);
const target = join(vercelOutput, 'static');
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log('已将本地化、精简和搜索索引同步到 Vercel 静态产物。');
