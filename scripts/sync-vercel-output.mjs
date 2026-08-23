import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
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

const source = getBuildOutputDirectory(root);
const target = join(vercelOutput, 'static');
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log('已将本地化、精简和搜索索引同步到 Vercel 静态产物。');
