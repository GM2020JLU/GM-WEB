import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const dist = join(process.cwd(), 'dist');
const unusedPaths = [
  'audio',
  'images',
  'fonts/ChillRoundM.ttf',
  'fonts/LXGWWenKai-Regular.ttf',
  'site.webmanifest',
  'browserconfig.xml',
  'favicon-96x96.png',
  'apple-icon.png',
];

for (const relative of unusedPaths) {
  const target = join(dist, relative);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
}

for (const prefix of ['android-icon-', 'apple-icon-', 'ms-icon-']) {
  for (const entry of readdirSync(dist)) {
    if (entry.startsWith(prefix) && entry.endsWith('.png')) {
      rmSync(join(dist, entry), { force: true });
    }
  }
}

console.log('已从生产产物中移除 Navfolio 演示资源和字体源文件。');
