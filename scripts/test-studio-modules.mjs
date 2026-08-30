#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = 4393;
const origin = `http://127.0.0.1:${port}`;
const runId = `${Date.now().toString(36)}-${process.pid.toString(36)}-${randomBytes(4).toString('hex')}`;
const revisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
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
const moduleItems = [];
const runtimeDirectory = await mkdtemp(join(tmpdir(), 'navfolio-studio-modules-'));
let uploadedAsset;
const cleanupErrors = [];

async function responseJson(path, init = {}) {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: { Origin: origin, ...init.headers },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${path} (${response.status}): 响应不是 JSON。`);
  }
  return { body, response };
}

async function json(path, init) {
  const result = await responseJson(path, init);
  if (!result.response.ok) {
    throw new Error(`${path} (${result.response.status}): ${result.body?.error ?? 'unknown'}`);
  }
  return result.body;
}

function jsonMutation(method, body) {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`${origin}/studio`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Studio 测试服务器未启动。');
}

async function stopServer(server) {
  if (server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (server.exitCode === null) {
    server.kill('SIGKILL');
    await once(server, 'exit');
  }
}

const server = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port)], {
  env: {
    ...process.env,
    PUBLIC_KEYSTATIC_STORAGE_KIND: 'local',
    PUBLIC_STUDIO_DEPLOYMENT_MODE: 'disabled',
    STUDIO_RUNTIME_DIR: runtimeDirectory,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (chunk) => process.stdout.write(chunk));
server.stderr.on('data', (chunk) => process.stderr.write(chunk));

try {
  await waitForServer();

  const site = await json('/api/studio/site');
  assert.match(site.sha, revisionPattern);
  assert.ok(site.settings && typeof site.settings === 'object');
  assert.ok(String(site.settings.site?.title ?? '').trim());
  assert.ok(String(site.settings.site?.description ?? '').trim());
  assert.ok(String(site.settings.profile?.name ?? '').trim());
  assert.match(String(site.settings.profile?.email ?? ''), /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  assert.doesNotThrow(() => new URL(site.settings.profile?.avatar));
  assert.ok(String(site.settings.home?.introTitle ?? '').trim());
  assert.ok(String(site.settings.pages?.blog?.title ?? '').trim());

  const initialAssets = await json('/api/studio/assets');
  assert.ok(Array.isArray(initialAssets.assets));
  for (const asset of initialAssets.assets) {
    assert.match(asset.path, /^src\/assets\/images\/content\//);
    assert.match(asset.sha, revisionPattern);
    assert.equal(typeof asset.size, 'number');
  }

  const assetFilename = `studio-module-${runId}.png`;
  const form = new FormData();
  form.append('file', new File([onePixelPng], assetFilename, { type: 'image/png' }));
  const upload = await json('/api/studio/assets', { method: 'POST', body: form });
  assert.equal(upload.ok, true);
  assert.match(upload.path, /^src\/assets\/images\/content\//);
  assert.equal(upload.reference, `@assets/${upload.path.slice('src/assets/'.length)}`);
  uploadedAsset = { path: upload.path };

  const assetsAfterUpload = await json('/api/studio/assets');
  const uploaded = assetsAfterUpload.assets.find((asset) => asset.path === upload.path);
  assert.ok(uploaded, '上传后的素材应能通过 assets GET 回读。');
  assert.match(uploaded.sha, revisionPattern);
  assert.equal(uploaded.size, onePixelPng.byteLength);
  uploadedAsset.sha = uploaded.sha;

  const incompleteRoute = await fetch(`${origin}/api/studio/content/blog`);
  assert.equal(incompleteRoute.status, 400);
  assert.match((await incompleteRoute.json()).error, /缺少内容标识/);

  for (const [index, definition] of definitions.entries()) {
    const requestedSlug = `${definition.collection}-module-flow-${runId}`;
    const assetMarkdown = index === 0 ? `\n\n![模块回归素材](${upload.reference})` : '';
    const source = `---\ntitle: ${definition.title}\n---\n\n# 初始正文\n\n导入阶段。${assetMarkdown}`;
    const imported = await json('/api/studio/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...definition,
        filename: `${requestedSlug}.md`,
        source,
        slug: requestedSlug,
        creator: definition.creator ?? '',
      }),
    });
    const slug = imported.slug;
    const item = { collection: definition.collection, path: imported.path, slug };
    created.push(item);
    moduleItems.push({ collection: item.collection, slug: item.slug });
    assert.equal(imported.collection, definition.collection);

    const endpoint = `/api/studio/content/${definition.collection}/${slug}`;
    let loaded = await json(endpoint);
    assert.equal(loaded.document.metadata.publicationStatus, 'draft');
    assert.match(loaded.document.sha, revisionPattern);

    if (index === 0) {
      assert.ok(loaded.document.body.includes(upload.reference));
      const blockedDelete = await responseJson(
        '/api/studio/assets',
        jsonMutation('DELETE', { path: uploadedAsset.path, sha: uploadedAsset.sha }),
      );
      assert.equal(blockedDelete.response.status, 409);
      assert.equal(blockedDelete.body.code, 'ASSET_IN_USE');
      assert.ok(Array.isArray(blockedDelete.body.references));
      assert.ok(blockedDelete.body.references.includes(imported.path));

      const referenceMarkdown = `![模块回归素材](${upload.reference})`;
      const withoutReference = loaded.document.body.replace(referenceMarkdown, '').trimEnd();
      assert.ok(!withoutReference.includes(upload.reference));
      const savedDraft = await json(
        endpoint,
        jsonMutation('PUT', {
          action: 'draft',
          body: withoutReference,
          expectedSha: loaded.document.sha,
          metadata: loaded.document.metadata,
          originalSlug: slug,
          slug,
        }),
      );
      assert.equal(savedDraft.status, 'draft');
      assert.match(savedDraft.sha, revisionPattern);

      const deletedAsset = await json(
        '/api/studio/assets',
        jsonMutation('DELETE', { path: uploadedAsset.path, sha: uploadedAsset.sha }),
      );
      assert.equal(deletedAsset.ok, true);
      uploadedAsset = undefined;
      const assetsAfterDelete = await json('/api/studio/assets');
      assert.ok(!assetsAfterDelete.assets.some((asset) => asset.path === upload.path));
      loaded = await json(endpoint);
    }

    loaded.document.metadata.title = `${definition.title}已编辑`;
    const published = await json(
      endpoint,
      jsonMutation('PUT', {
        action: 'publish',
        body: `${loaded.document.body}\n\n编辑并发布。`,
        expectedSha: loaded.document.sha,
        metadata: loaded.document.metadata,
        originalSlug: slug,
        slug,
      }),
    );
    assert.equal(published.status, 'published');
    assert.equal(published.deploymentPending, false);
    assert.match(published.sha, revisionPattern);
    const verified = await json(endpoint);
    assert.equal(verified.document.metadata.title, `${definition.title}已编辑`);
    assert.equal(verified.document.metadata.publicationStatus, 'published');
    assert.match(verified.document.body, /编辑并发布/);
  }

  const historyItem = moduleItems[0];
  const historyEndpoint = `/api/studio/history/${historyItem.collection}/${historyItem.slug}`;
  const historyResult = await json(historyEndpoint);
  assert.ok(Array.isArray(historyResult.history));
  assert.ok(historyResult.history.length > 0);
  const historyEntry = historyResult.history.find(
    (entry) => entry.message === `Publish ${historyItem.collection}: ${historyItem.slug}`,
  );
  assert.ok(historyEntry, '发布前的草稿版本应出现在历史记录中。');
  assert.match(historyEntry.sha, /^[a-f0-9]{40}$/i);
  const beforeRestore = await json(
    `/api/studio/content/${historyItem.collection}/${historyItem.slug}`,
  );
  const restored = await json(
    historyEndpoint,
    jsonMutation('POST', {
      expectedSha: beforeRestore.document.sha,
      ref: historyEntry.sha,
    }),
  );
  assert.equal(restored.ok, true);
  assert.equal(restored.status, 'draft');
  assert.equal(restored.deploymentPending, false);
  assert.match(restored.sha, revisionPattern);
  const restoredDocument = await json(
    `/api/studio/content/${historyItem.collection}/${historyItem.slug}`,
  );
  assert.equal(restoredDocument.document.sha, restored.sha);
  assert.equal(restoredDocument.document.metadata.publicationStatus, 'draft');
  assert.ok(!restoredDocument.document.body.includes(upload.reference));

  const missingSlug = `blog-missing-asset-${runId}`;
  const missingReference = `@assets/images/content/missing-${runId}.png`;
  const missingImported = await json('/api/studio/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collection: 'blog',
      title: '缺失素材批量发布回归',
      description: '验证批量发布在素材缺失时保持原草稿不变。',
      filename: `${missingSlug}.md`,
      slug: missingSlug,
      source: `---\ntitle: 缺失素材批量发布回归\n---\n\n# 缺失素材\n\n![alt](${missingReference})`,
    }),
  });
  const missingItem = {
    collection: missingImported.collection,
    path: missingImported.path,
    slug: missingImported.slug,
  };
  created.push(missingItem);
  const missingEndpoint = `/api/studio/content/${missingItem.collection}/${missingItem.slug}`;
  const missingBefore = await json(missingEndpoint);
  assert.equal(missingBefore.document.metadata.publicationStatus, 'draft');
  const rejectedBulkPublish = await responseJson(
    '/api/studio/bulk',
    jsonMutation('POST', {
      action: 'publish',
      items: [{ collection: missingItem.collection, slug: missingItem.slug }],
    }),
  );
  assert.equal(rejectedBulkPublish.response.status, 400);
  assert.ok(String(rejectedBulkPublish.body.error ?? '').includes(missingReference));
  const missingAfter = await json(missingEndpoint);
  assert.equal(missingAfter.document.sha, missingBefore.document.sha);
  assert.equal(missingAfter.document.metadata.publicationStatus, 'draft');

  const drafted = await json(
    '/api/studio/bulk',
    jsonMutation('POST', { action: 'draft', items: moduleItems }),
  );
  assert.equal(drafted.ok, true);
  assert.equal(drafted.status, 'draft');
  assert.equal(drafted.updated, moduleItems.length);
  assert.equal(drafted.deploymentPending, false);
  for (const item of moduleItems) {
    const loaded = await json(`/api/studio/content/${item.collection}/${item.slug}`);
    assert.equal(loaded.document.metadata.publicationStatus, 'draft');
    assert.match(loaded.document.sha, revisionPattern);
  }

  const bulkPublished = await json(
    '/api/studio/bulk',
    jsonMutation('POST', { action: 'publish', items: moduleItems }),
  );
  assert.equal(bulkPublished.ok, true);
  assert.equal(bulkPublished.status, 'published');
  assert.equal(bulkPublished.updated, moduleItems.length);
  assert.equal(bulkPublished.deploymentPending, false);
  for (const item of moduleItems) {
    const loaded = await json(`/api/studio/content/${item.collection}/${item.slug}`);
    assert.equal(loaded.document.metadata.publicationStatus, 'published');
    assert.match(loaded.document.sha, revisionPattern);
  }

  console.log(
    'Studio 模块 HTTP 验证通过：站点设置、素材引用保护、历史恢复、批量校验及 Blog、Projects、Vibe、Media 发布回读均正常。',
  );
} finally {
  for (const item of created.reverse()) {
    const endpoint = `/api/studio/content/${item.collection}/${item.slug}`;
    try {
      const loaded = await responseJson(endpoint);
      if (loaded.response.status === 404) continue;
      if (!loaded.response.ok) {
        throw new Error(
          `${endpoint} (${loaded.response.status}): ${loaded.body?.error ?? 'unknown'}`,
        );
      }
      assert.match(loaded.body.document.sha, revisionPattern);
      await json(endpoint, jsonMutation('DELETE', { expectedSha: loaded.body.document.sha }));
    } catch (error) {
      cleanupErrors.push(error);
      console.error(`清理 ${item.collection}/${item.slug} 失败`, error);
    }
  }
  if (uploadedAsset) {
    try {
      const listed = await json('/api/studio/assets');
      const current = listed.assets.find((asset) => asset.path === uploadedAsset.path);
      if (current) {
        assert.match(current.sha, revisionPattern);
        await json(
          '/api/studio/assets',
          jsonMutation('DELETE', { path: current.path, sha: current.sha }),
        );
      }
    } catch (error) {
      cleanupErrors.push(error);
      console.error(`清理素材 ${uploadedAsset.path} 失败`, error);
    }
  }
  await stopServer(server);
  spawnSync('bunx', ['astro', 'dev', 'stop'], { stdio: 'ignore' });
  await rm(runtimeDirectory, { recursive: true, force: true });
  if (cleanupErrors.length) {
    throw new AggregateError(cleanupErrors, 'Studio 模块回归留下了未清理的临时文件。');
  }
}
