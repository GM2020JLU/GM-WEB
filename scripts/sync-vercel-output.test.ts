import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicVercelOutput } from './sync-vercel-output.mjs';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'navfolio-vercel-output-'));
  roots.push(root);
  await Promise.all([
    mkdir(join(root, 'dist/client/_astro'), { recursive: true }),
    mkdir(join(root, 'dist/client/studio'), { recursive: true }),
    mkdir(join(root, 'dist/client/preview/post'), { recursive: true }),
    mkdir(join(root, '.vercel/output/functions/_render.func'), { recursive: true }),
    mkdir(join(root, '.vercel/output/_functions/chunks'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(root, '.vercel/output/config.json'),
      JSON.stringify({
        version: 3,
        routes: [
          { handle: 'filesystem' },
          { src: '^/api/studio', dest: '_render' },
          { src: '^/.*$', dest: '/404.html', status: 404 },
        ],
      }),
    ),
    writeFile(
      join(root, 'dist/client/index.html'),
      '<script type="module" src="/_astro/public.js"></script>',
    ),
    writeFile(join(root, 'dist/client/404.html'), '<h1>not found</h1>'),
    writeFile(join(root, 'dist/client/studio/index.html'), '/_astro/keystatic-page.js'),
    writeFile(join(root, 'dist/client/preview/post/index.html'), 'private preview'),
    writeFile(join(root, 'dist/client/_astro/public.js'), 'import "./shared.js";'),
    writeFile(join(root, 'dist/client/_astro/shared.js'), 'console.log("public")'),
    writeFile(join(root, 'dist/client/_astro/keystatic-page.js'), 'private'),
    writeFile(join(root, 'dist/client/_astro/react-dom.js'), 'private'),
    writeFile(join(root, '.vercel/output/functions/_render.func/index.js'), 'private'),
    writeFile(join(root, '.vercel/output/_functions/chunks/private.mjs'), 'private'),
  ]);
  return root;
}

describe('Vercel 公共产物裁剪', () => {
  test('删除后台路由、函数与不可达 chunk，保留公共依赖闭包', async () => {
    const root = await fixture();
    const result = createPublicVercelOutput(root);
    expect(result.skipped).toBe(false);
    expect(existsSync(join(root, '.vercel/output/functions'))).toBe(false);
    expect(existsSync(join(root, '.vercel/output/_functions'))).toBe(false);
    expect(existsSync(join(root, '.vercel/output/static/studio'))).toBe(false);
    expect(existsSync(join(root, '.vercel/output/static/preview'))).toBe(false);
    expect(existsSync(join(root, '.vercel/output/static/_astro/public.js'))).toBe(true);
    expect(existsSync(join(root, '.vercel/output/static/_astro/shared.js'))).toBe(true);
    expect(existsSync(join(root, '.vercel/output/static/_astro/keystatic-page.js'))).toBe(false);
    expect(existsSync(join(root, '.vercel/output/static/_astro/react-dom.js'))).toBe(false);
    const configSource = await readFile(join(root, '.vercel/output/config.json'), 'utf8');
    expect(configSource).not.toContain('"dest": "_render"');
    expect(configSource).toContain('api/studio');
    const config = JSON.parse(configSource);
    expect(config.routes.slice(0, 3)).toEqual([
      {
        src: '^/studio/?$',
        status: 307,
        headers: { Location: 'https://studio.goumin.work/' },
      },
      {
        src: '^/studio/(.*)$',
        status: 307,
        headers: { Location: 'https://studio.goumin.work/studio/$1' },
      },
      expect.objectContaining({ dest: '/404.html', status: 404 }),
    ]);
  });
});
