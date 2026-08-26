#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';

const port = 4393;
const origin = `http://127.0.0.1:${port}`;
const definitions = [
  {
    collection: 'blog',
    title: '模块回归博客',
    description: '这是用于验证博客模块发布流程的完整摘要。',
  },
  {
    collection: 'projects',
    title: '模块回归项目',
    description: '这是用于验证项目模块发布流程的完整摘要。',
  },
  { collection: 'vibe', title: '模块回归随记', description: '' },
  { collection: 'media', title: '模块回归书影音', description: '', creator: '回归作者' },
];
const created = [];

async function json(path, init) {
  const response = await fetch(`${origin}${path}`, init);
  const body = await response.json();
  if (!response.ok) throw new Error(`${path} (${response.status}): ${body.error ?? 'unknown'}`);
  return body;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`${origin}/studio`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Studio 测试服务器未启动。');
}

const server = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (chunk) => process.stdout.write(chunk));
server.stderr.on('data', (chunk) => process.stderr.write(chunk));

try {
  await waitForServer();
  const incompleteRoute = await fetch(`${origin}/api/studio/content/blog`);
  assert.equal(incompleteRoute.status, 400);
  assert.match((await incompleteRoute.json()).error, /缺少内容标识/);

  for (const definition of definitions) {
    const source = `---\ntitle: ${definition.title}\n---\n\n# 初始正文\n\n导入阶段。`;
    const imported = await json('/api/studio/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({
        ...definition,
        filename: `${definition.collection}-module-flow.md`,
        source,
        slug: `${definition.collection}-module-flow`,
        creator: definition.creator ?? '',
      }),
    });
    const slug = imported.slug;
    created.push({ collection: definition.collection, slug });
    assert.equal(imported.collection, definition.collection);

    const endpoint = `/api/studio/content/${definition.collection}/${slug}`;
    const loaded = await json(endpoint);
    assert.equal(loaded.document.metadata.publicationStatus, 'draft');
    loaded.document.metadata.title = `${definition.title}已编辑`;
    const published = await json(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({
        action: 'publish',
        body: `${loaded.document.body}\n\n编辑并发布。`,
        metadata: loaded.document.metadata,
        originalSlug: slug,
        slug,
      }),
    });
    assert.equal(published.status, 'published');
    const verified = await json(endpoint);
    assert.equal(verified.document.metadata.title, `${definition.title}已编辑`);
    assert.equal(verified.document.metadata.publicationStatus, 'published');
    assert.match(verified.document.body, /编辑并发布/);
  }
  console.log(
    'Studio 模块 HTTP 验证通过：Blog、Projects、Vibe、Media 均完成导入、编辑、发布和回读。',
  );
} finally {
  for (const item of created.reverse()) {
    try {
      await json(`/api/studio/content/${item.collection}/${item.slug}`, {
        method: 'DELETE',
        headers: { Origin: origin },
      });
    } catch (error) {
      console.error(`清理 ${item.collection}/${item.slug} 失败`, error);
    }
  }
  server.kill('SIGTERM');
  spawnSync('bunx', ['astro', 'dev', 'stop'], { stdio: 'ignore' });
}
