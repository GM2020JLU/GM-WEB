import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { getBuildOutputDirectory } from './build-output.mjs';
import { htmlFileToRoute, isPublicHtmlFile } from './lib/public-routes.mjs';

function walkHtml(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return walkHtml(absolute);
    return entry.isFile() && entry.name.endsWith('.html') ? [absolute] : [];
  });
}

const root = process.cwd();
const output = getBuildOutputDirectory(root);
const pagefind = join(root, 'node_modules', '.bin', 'pagefind');
const staging = mkdtempSync(join(tmpdir(), 'navfolio-pagefind-'));
const publicFiles = walkHtml(output).filter((file) => isPublicHtmlFile(file, output));
const publicRoutes = publicFiles
  .map((file) => htmlFileToRoute(file, output))
  .filter(Boolean)
  .sort();

for (const file of publicFiles) {
  const target = join(staging, relative(output, file));
  mkdirSync(dirname(target), { recursive: true });
  const html = readFileSync(file, 'utf8');
  const searchableHtml = html.includes('data-pagefind-body')
    ? html
    : html.replace(/<main(?=[\s>])/iu, '<main data-pagefind-body');
  writeFileSync(target, searchableHtml);
}

let result;
try {
  result = spawnSync(
    pagefind,
    [
      '--site',
      staging,
      '--output-path',
      join(output, 'pagefind'),
      '--root-selector',
      'main',
      '--exclude-selectors',
      '[data-pagefind-ignore]',
    ],
    { stdio: 'inherit' },
  );

  if (!result.error && result.status === 0) {
    const entry = JSON.parse(readFileSync(join(output, 'pagefind/pagefind-entry.json'), 'utf8'));
    writeFileSync(
      join(output, 'pagefind/navfolio-public-pages.json'),
      `${JSON.stringify({ pageCount: entry.languages?.zh?.page_count ?? null, routes: publicRoutes }, null, 2)}\n`,
    );
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
