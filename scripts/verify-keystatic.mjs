import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createReader } from '@keystatic/core/reader';
import { fromMarkdown } from 'mdast-util-from-markdown';

import keystaticConfig from '../keystatic.config.ts';

const root = process.cwd();
const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
const reader = createReader(root, keystaticConfig);
const configSource = readFileSync(join(root, 'keystatic.config.ts'), 'utf8');
assert(
  !/\bprocess\.env\b/.test(configSource),
  'keystatic.config.ts 会在浏览器端运行，不得使用 process.env',
);
const browserCoreUrl = pathToFileURL(
  join(root, 'node_modules', '@keystatic', 'core', 'dist', 'keystatic-core.js'),
).href;
const { fields: browserFields } = await import(browserCoreUrl);

for (const key of ['blog', 'projects', 'vibe', 'media']) {
  const configured = keystaticConfig.collections[key];
  assert(configured.previewUrl?.startsWith(`/preview/${key}`), `${key} 未配置真实预览地址`);
  assert(configured.columns?.includes('publicationStatus'), `${key} 内容列表缺少发布状态列`);
  assert(configured.schema.publicationStatus, `${key} 缺少发布状态字段`);
  assert(configured.schema.updatedDate, `${key} 缺少自动更新时间字段`);
}
for (const key of ['categories', 'series', 'tags']) {
  assert(keystaticConfig.collections[key], `缺少受控分类集合：${key}`);
}
assert.equal(keystaticConfig.singletons.about.previewUrl, '/preview/about');

const blogSchema = keystaticConfig.collections.blog.schema;
assert.equal(blogSchema.heroImage.formKind, 'asset', '博客封面未使用媒体选择字段');
assert.equal(blogSchema.heroImage.directory, 'src/assets/images/content');
assert.equal(blogSchema.date.parse('2026-08-25T12:34:56+08:00'), '2026-08-25T12:34');
assert.deepEqual(blogSchema.date.serialize('2026-08-25T12:34'), {
  value: '2026-08-25T12:34:00+08:00',
});
assert.match(
  blogSchema.updatedDate.serialize('ignored').value,
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/u,
  '自动更新时间格式无效',
);

function withoutPositions(value) {
  if (Array.isArray(value)) return value.map(withoutPositions);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'position')
      .map(([key, child]) => [key, withoutPositions(child)]),
  );
}

function readContentFile(file) {
  const bytes = readFileSync(file);
  const source = decoder.decode(bytes);
  assert(!source.startsWith('\uFEFF'), `${file} 含 UTF-8 BOM`);
  assert(!source.includes('\uFFFD'), `${file} 含替换字符，可能已乱码`);

  const match = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  assert(match, `${file} 缺少完整的 frontmatter`);
  return match[1];
}

async function verifyEditorRoundTrip(file, slug) {
  const body = readContentFile(file);
  assert(!/^\s*(?:import|export)\s/m.test(body), `${file} 含 Keystatic 不支持的 MDX import/export`);
  assert(!/<\/?[A-Za-z][^>]*>/.test(body), `${file} 含 Keystatic 不支持的 HTML/JSX 标签`);

  const extension = extname(file) === '.mdx' ? 'mdx' : 'md';
  const bodyField = browserFields.mdx({ label: '正文', extension });
  const editorValue = bodyField.parse(undefined, {
    content: encoder.encode(body),
    other: new Map(),
    external: new Map(),
    slug,
  });
  const saved = bodyField.serialize(editorValue, { slug });
  assert(saved.content, `${file} 经编辑器往返后正文丢失`);

  const savedBody = decoder.decode(saved.content);
  assert(!savedBody.includes('\uFFFD'), `${file} 经编辑器往返后出现乱码`);
  assert.deepEqual(
    withoutPositions(fromMarkdown(savedBody)),
    withoutPositions(fromMarkdown(body)),
    `${file} 经编辑器往返后 Markdown 结构改变`,
  );
}

const collections = [
  ['blog', 'src/content/blog'],
  ['projects', 'src/content/projects'],
  ['vibe', 'src/content/vibe'],
];

let entriesChecked = 0;
for (const [key, directory] of collections) {
  const collectionReader = reader.collections[key];
  const entries = await collectionReader.all();
  assert(entries.length > 0, `Keystatic 未读取到 ${key} 内容`);

  for (const { slug, entry } of entries) {
    const body = await entry.body();
    assert.equal(typeof entry.title, 'string', `${key}/${slug} 标题不是字符串`);
    assert(!entry.title.includes('\uFFFD'), `${key}/${slug} 标题已乱码`);
    assert(!body.includes('\uFFFD'), `${key}/${slug} 正文已乱码`);

    const candidates = readdirSync(join(root, directory)).filter(
      (name) => name === `${slug}.md` || name === `${slug}.mdx`,
    );
    assert.equal(candidates.length, 1, `${key}/${slug} 无法唯一对应到内容文件`);
    await verifyEditorRoundTrip(join(root, directory, candidates[0]), slug);
    entriesChecked += 1;
  }
}

const about = await reader.singletons.about.readOrThrow();
const aboutBody = await about.body();
assert.equal(about.title, '关于我');
assert(aboutBody.includes('嵌入式系统工程师'));
await verifyEditorRoundTrip(join(root, 'src/content/about.mdx'), 'about');
entriesChecked += 1;

assert.equal(
  keystaticConfig.storage.kind,
  import.meta.env.PUBLIC_KEYSTATIC_STORAGE_KIND === 'github' ||
    (import.meta.env.PUBLIC_KEYSTATIC_STORAGE_KIND !== 'local' && import.meta.env.PROD)
    ? 'github'
    : 'local',
);

console.log(
  `Keystatic 兼容验证通过：${entriesChecked} 份内容均可读取，UTF-8 和 Markdown 语义往返一致。`,
);
process.exit(0);
