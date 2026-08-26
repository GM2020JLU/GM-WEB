import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { makeGenericAPIRouteHandler } from '@keystatic/core/api/generic';
import { createReader } from '@keystatic/core/reader';

import keystaticConfig from '../keystatic.config.ts';

const encoder = new TextEncoder();
const root = await mkdtemp(path.join(os.tmpdir(), 'gm-keystatic-crud-'));
const slug = 'qa-full-workflow';
const png = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
);

function encode(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  return Buffer.from(bytes).toString('base64url');
}

const files = {
  'src/content/taxonomies/tags/质量验证.yaml': `title: 质量验证\ndescription: CRUD 测试标签\n`,
  'src/content/taxonomies/categories/测试分类.yaml': `title: 测试分类\ndescription: CRUD 测试分类\n`,
  'src/content/taxonomies/series/测试系列.yaml': `title: 测试系列\ndescription: CRUD 测试系列\n`,
  [`src/content/blog/${slug}.md`]: `---
title: 全流程测试文章
description: 用于验证后台创建、读取、更新和删除的临时文章。
date: '2026-08-26T08:30:00+08:00'
updatedDate: '2026-08-26T08:31:00+08:00'
publicationStatus: draft
heroImage: '@assets/images/content/${slug}/heroImage.png'
heroImageAlt: 绿色像素测试图
showHeroImage: true
tags: [质量验证]
categories: [测试分类]
series: [测试系列]
comments: false
sidebar: { enable: true, toc: true, relatedPosts: true }
---

## 第一次保存

正文能被 Reader 正确读取。
`,
  [`src/content/projects/${slug}.mdx`]: `---
title: 全流程测试项目
description: 用于验证项目集合。
date: '2026-08-26T08:30:00+08:00'
updatedDate: '2026-08-26T08:31:00+08:00'
publicationStatus: draft
showHeroImage: false
role: 独立测试
period: '2026.08'
highlights: [完成 CRUD 回归]
links:
  - label: 测试链接
    href: https://example.com
    kind: website
tags: [质量验证]
categories: []
series: []
comments: false
sidebar: { enable: false, toc: false, relatedPosts: false }
---

项目正文。
`,
  [`src/content/vibe/${slug}.md`]: `---
title: 全流程测试随记
date: '2026-08-26T08:30:00+08:00'
updatedDate: '2026-08-26T08:31:00+08:00'
publicationStatus: draft
type: photo
mood: 专注
location: 测试环境
images: ['@assets/images/content/${slug}/vibe-image.png']
tags: [质量验证]
align: left
size: md
---

随记正文。
`,
  [`src/content/media/${slug}.md`]: `---
title: 全流程测试书目
creator: 测试作者
publicationStatus: draft
updatedDate: '2026-08-26T08:31:00+08:00'
type: book
status: in-progress
cover: '@assets/images/content/${slug}/cover.png'
coverAspect: portrait
rating: 4
review: false
tags: [质量验证]
---

书影音短评。
`,
  'src/content/about.mdx': `---
title: 测试关于页
description: 用于验证单页编辑。
date: '2026-08-26T08:30:00+08:00'
updatedDate: '2026-08-26T08:31:00+08:00'
publicationStatus: draft
showHeroImage: false
tags: []
categories: []
series: []
comments: false
sidebar: { enable: false, toc: false, relatedPosts: false }
---

关于页正文。
`,
  [`src/assets/images/content/${slug}/heroImage.png`]: png,
  [`src/assets/images/content/${slug}/vibe-image.png`]: png,
  [`src/assets/images/content/${slug}/cover.png`]: png,
};

const handler = makeGenericAPIRouteHandler({
  config: keystaticConfig,
  localBaseDirectory: root,
});

async function request(route, init = {}) {
  return handler(new Request(`http://localhost/api/keystatic/${route}`, init));
}

async function update(additions, deletions = []) {
  return request('update', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'no-cors': '1' },
    body: JSON.stringify({
      additions: Object.entries(additions).map(([filePath, contents]) => ({
        path: filePath,
        contents: encode(contents),
      })),
      deletions: deletions.map((filePath) => ({ path: filePath })),
    }),
  });
}

try {
  const blocked = await request('update', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'no-cors': '1' },
    body: JSON.stringify({
      additions: [{ path: '../escape.md', contents: encode('blocked') }],
      deletions: [],
    }),
  });
  assert.equal(blocked.status, 400, '路径穿越写入没有被拒绝');

  const created = await update(files);
  assert.equal(created.status, 200, '批量创建内容失败');
  assert(JSON.stringify(JSON.parse(created.body)).includes(slug), '创建后目录树未包含测试内容');

  let reader = createReader(root, keystaticConfig);
  const blog = await reader.collections.blog.readOrThrow(slug);
  assert.equal(blog.title, '全流程测试文章');
  assert.equal(blog.publicationStatus, 'draft');
  assert.deepEqual(blog.tags, ['质量验证']);
  assert.equal(blog.heroImage, `@assets/images/content/${slug}/heroImage.png`);
  assert((await blog.body()).includes('第一次保存'));

  const project = await reader.collections.projects.readOrThrow(slug);
  assert.equal(project.title, '全流程测试项目');
  assert.equal(project.role, '独立测试');
  assert.deepEqual(project.highlights, ['完成 CRUD 回归']);
  assert.equal((await reader.collections.vibe.readOrThrow(slug)).mood, '专注');
  assert.equal((await reader.collections.media.readOrThrow(slug)).creator, '测试作者');
  assert.equal((await reader.collections.tags.readOrThrow('质量验证')).title, '质量验证');
  assert.equal((await reader.singletons.about.readOrThrow()).title, '测试关于页');

  const updatedBlog = String(files[`src/content/blog/${slug}.md`])
    .replace('publicationStatus: draft', 'publicationStatus: ready')
    .replace("updatedDate: '2026-08-26T08:31:00+08:00'", "updatedDate: '2026-08-26T09:00:00+08:00'")
    .replace('第一次保存', '第二次保存');
  const updated = await update({ [`src/content/blog/${slug}.md`]: updatedBlog });
  assert.equal(updated.status, 200, '二次保存失败');
  reader = createReader(root, keystaticConfig);
  const reread = await reader.collections.blog.readOrThrow(slug);
  assert.equal(reread.publicationStatus, 'ready');
  assert((await reread.body()).includes('第二次保存'));

  const tree = await request('tree', { headers: { 'no-cors': '1' } });
  assert.equal(tree.status, 200, '目录读取失败');
  const missingHeader = await request('tree');
  assert.equal(missingHeader.status, 400, '目录接口缺少防跨域头时没有拒绝请求');

  const removed = await update({}, Object.keys(files));
  assert.equal(removed.status, 200, '删除测试内容失败');
  assert(!JSON.stringify(JSON.parse(removed.body)).includes(slug), '删除后仍残留测试内容');

  console.log('Keystatic CRUD 验证通过：创建、读取、二次保存、图片、关系、删除和路径保护均正常。');
} finally {
  await rm(root, { recursive: true, force: true });
}
