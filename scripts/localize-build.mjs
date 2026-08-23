import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

import { getBuildOutputDirectory } from './build-output.mjs';

const dist = getBuildOutputDirectory();
const replacements = new Map([['aria-label="Close image preview"', 'aria-label="关闭图片预览"']]);

function collectHtmlFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectHtmlFiles(path);
    return extname(entry.name) === '.html' ? [path] : [];
  });
}

let changedFiles = 0;
for (const file of collectHtmlFiles(dist)) {
  const original = readFileSync(file, 'utf8');
  let localized = original;

  for (const [source, target] of replacements) {
    localized = localized.replaceAll(source, target);
  }

  if (localized !== original) {
    writeFileSync(file, localized);
    changedFiles += 1;
  }
}

console.log(`已完成构建产物中文化兼容处理（${changedFiles} 个页面）。`);
