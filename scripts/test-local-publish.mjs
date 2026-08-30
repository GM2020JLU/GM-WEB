#!/usr/bin/env node

import assert from 'node:assert/strict';

const studioOrigin = process.env.STUDIO_TEST_ORIGIN;
const publicOrigin = process.env.PUBLIC_TEST_ORIGIN;
if (!studioOrigin || !publicOrigin) {
  throw new Error('需要同时设置 STUDIO_TEST_ORIGIN 和 PUBLIC_TEST_ORIGIN。');
}

const suffix = Date.now().toString(36);
const allDefinitions = [
  {
    collection: 'blog',
    title: `本地发布回归博客${suffix}`,
    description: '验证博客从导入、编辑、发布、上线到删除的完整本地流程。',
  },
  {
    collection: 'projects',
    title: `本地发布回归项目${suffix}`,
    description: '验证项目从导入、编辑、发布、上线到删除的完整本地流程。',
  },
  { collection: 'vibe', title: `本地发布回归随记${suffix}`, description: '' },
  {
    collection: 'media',
    title: `本地发布回归书影音${suffix}`,
    description: '',
    creator: '本地发布测试',
  },
];
const requestedCollections = new Set(
  (
    process.env.STUDIO_TEST_COLLECTIONS ||
    allDefinitions.map(({ collection }) => collection).join(',')
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const definitions = allDefinitions.filter(({ collection }) => requestedCollections.has(collection));
if (definitions.length === 0) throw new Error('没有可执行的 Studio 测试模块。');
const created = [];

async function request(path, init = {}) {
  const response = await fetch(new URL(path, studioOrigin), {
    ...init,
    headers: { Origin: studioOrigin, ...init.headers },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${path} (${response.status}): 响应不是 JSON。`);
  }
  if (!response.ok) throw new Error(`${path} (${response.status}): ${body?.error ?? 'unknown'}`);
  return body;
}

async function waitForStudio() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(new URL('/studio', studioOrigin), {
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('远程 Studio 在 30 秒内未就绪。');
}

async function waitForDeployment(targetSha) {
  for (let attempt = 0; attempt < 360; attempt++) {
    const { deployment } = await request(`/api/studio/deployment?sha=${targetSha}`);
    if (deployment.phase === 'ready') return deployment;
    if (deployment.phase === 'error') {
      throw new Error(`部署 ${targetSha} 失败：${deployment.logUrl ?? '无日志地址'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`部署 ${targetSha} 在 180 秒内未完成。`);
}

async function waitForPublic(publicUrl, title, visible) {
  const target = new URL(publicUrl, publicOrigin);
  target.hash = '';
  for (let attempt = 0; attempt < 60; attempt++) {
    target.searchParams.set('_studio_test', `${Date.now()}-${attempt}`);
    const response = await fetch(target, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.text();
    if ((visible && response.ok && body.includes(title)) || (!visible && !body.includes(title))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${target} 未在预期时间内${visible ? '显示' : '移除'}测试内容。`);
}

try {
  await waitForStudio();
  for (const definition of definitions) {
    const slug = `local-publish-${definition.collection}-${suffix}`;
    const imported = await request('/api/studio/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...definition,
        filename: `${slug}.md`,
        slug,
        source: `---\ntitle: ${definition.title}\n---\n\n# 本地发布回归\n\n导入阶段。`,
      }),
    });
    created.push({ collection: definition.collection, slug: imported.slug });

    const endpoint = `/api/studio/content/${definition.collection}/${imported.slug}`;
    const loaded = await request(endpoint);
    const published = await request(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'publish',
        body: `${loaded.document.body}\n\n已编辑并发布。`,
        expectedSha: loaded.document.sha,
        metadata: loaded.document.metadata,
        originalSlug: imported.slug,
        slug: imported.slug,
      }),
    });
    assert.equal(published.deploymentPending, true);
    assert.equal(published.deploymentProvider, 'local');
    assert.match(published.commitSha, /^[a-f0-9]{40}$/);
    assert.ok(published.publicUrl);
    await waitForDeployment(published.commitSha);
    await waitForPublic(published.publicUrl, definition.title, true);

    const removed = await request(endpoint, { method: 'DELETE' });
    assert.equal(removed.deploymentPending, true);
    created.pop();
    await waitForDeployment(removed.commitSha);
    await waitForPublic(published.publicUrl, definition.title, false);
    console.log(`${definition.collection}: 导入、编辑、发布、上线、删除、下线均通过。`);
  }
} finally {
  for (const item of created.reverse()) {
    try {
      const removed = await request(`/api/studio/content/${item.collection}/${item.slug}`, {
        method: 'DELETE',
      });
      if (removed.deploymentPending && removed.commitSha) {
        await waitForDeployment(removed.commitSha);
      }
    } catch (error) {
      console.error(`清理 ${item.collection}/${item.slug} 失败`, error);
    }
  }
}

console.log('Mac 本地发布闭环验证通过。');
