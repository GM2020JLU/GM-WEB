import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const STATUS = new Set(['draft', 'ready', 'published']);
const TAXONOMY_FIELDS = { tags: 'tags', categories: 'categories', series: 'series' };
const PLACEHOLDER = /\b(?:lorem|ipsum|test)\b|(?:casdcv|scvasdv|asdf{2,}|测试内容|占位内容)/iu;

export function parseDocument(source, file = 'unknown.md') {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match) return { file, data: {}, body: source, malformed: true };
  try {
    return {
      file,
      data: yaml.load(match[1]) ?? {},
      body: source.slice(match[0].length),
      malformed: false,
    };
  } catch (error) {
    return {
      file,
      data: {},
      body: source,
      malformed: true,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function publicationStatus(data) {
  return data.publicationStatus ?? (data.draft ? 'draft' : 'published');
}

function issue(level, file, message) {
  return { level, file, message };
}

function validDate(value) {
  return typeof value === 'string' || value instanceof Date
    ? !Number.isNaN(new Date(value).valueOf())
    : false;
}

export function auditDocuments(documents, options = {}) {
  const issues = [];
  const taxonomies = options.taxonomies ?? {
    tags: new Set(),
    categories: new Set(),
    series: new Set(),
  };
  const exists = options.assetExists ?? (() => true);
  const seen = new Map();

  for (const document of documents) {
    const { file, data, body, malformed, parseError } = document;
    const collection = document.collection ?? 'blog';
    if (malformed) {
      issues.push(
        issue('error', file, `Frontmatter 无法读取${parseError ? `：${parseError}` : ''}`),
      );
      continue;
    }
    const status = publicationStatus(data);
    const blocking = status === 'ready' || status === 'published';
    const level = blocking ? 'error' : 'warning';
    if (!STATUS.has(status)) issues.push(issue('error', file, `未知发布状态：${status}`));

    const slug = path.basename(file).replace(/\.(?:md|mdx)$/u, '');
    const duplicateKey = `${collection}:${slug}`;
    if (seen.has(duplicateKey))
      issues.push(issue('error', file, `网址别名与 ${seen.get(duplicateKey)} 重复：${slug}`));
    seen.set(duplicateKey, file);

    if (!String(data.title ?? '').trim()) issues.push(issue(level, file, '缺少标题'));
    if (
      (collection === 'blog' || collection === 'projects' || collection === 'about') &&
      !String(data.description ?? '').trim()
    )
      issues.push(issue(level, file, '缺少摘要'));
    if (collection !== 'media' && !validDate(data.date))
      issues.push(issue(level, file, '发布日期无效或缺失'));
    if (collection === 'media' && !String(data.creator ?? '').trim())
      issues.push(issue(level, file, '缺少创作者'));
    if (blocking && !validDate(data.updatedDate))
      issues.push(issue('error', file, '缺少自动更新时间；请在后台重新保存一次'));
    if (blocking && PLACEHOLDER.test(`${data.title ?? ''}\n${data.description ?? ''}\n${body}`))
      issues.push(issue('error', file, '检测到测试或占位内容'));

    if (data.heroImage && !String(data.heroImageAlt ?? '').trim())
      issues.push(issue(level, file, '封面图缺少替代文本'));
    const markdownImages = [...body.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+['"][^'"]*['"])?\)/gu)];
    for (const [, alt, src] of markdownImages) {
      if (!alt.trim()) issues.push(issue(level, file, `正文图片缺少替代文本：${src}`));
      if (!/^https?:\/\//iu.test(src) && !exists(src, file))
        issues.push(issue(level, file, `图片文件不存在：${src}`));
    }
    for (const key of ['heroImage', 'cover']) {
      const src = data[key];
      if (typeof src === 'string' && !/^https?:\/\//iu.test(src) && !exists(src, file))
        issues.push(issue(level, file, `${key} 文件不存在：${src}`));
    }
    for (const src of Array.isArray(data.images) ? data.images : []) {
      if (typeof src === 'string' && !/^https?:\/\//iu.test(src) && !exists(src, file))
        issues.push(issue(level, file, `图片文件不存在：${src}`));
    }

    for (const [field, taxonomy] of Object.entries(TAXONOMY_FIELDS)) {
      for (const value of Array.isArray(data[field]) ? data[field] : []) {
        if (!taxonomies[taxonomy]?.has(String(value)))
          issues.push(issue(level, file, `${field} 引用了未登记项：${value}`));
      }
    }
  }

  return issues;
}

function walkMarkdown(directory, collection) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkMarkdown(absolute, collection);
    if (!/\.(?:md|mdx)$/u.test(entry.name)) return [];
    return [{ ...parseDocument(fs.readFileSync(absolute, 'utf8'), absolute), collection }];
  });
}

export function auditRepository(root) {
  const contentRoot = path.join(root, 'src/content');
  const documents = ['blog', 'projects', 'vibe', 'media'].flatMap((name) =>
    walkMarkdown(path.join(contentRoot, name), name),
  );
  for (const extension of ['md', 'mdx']) {
    const about = path.join(contentRoot, `about.${extension}`);
    if (fs.existsSync(about))
      documents.push({
        ...parseDocument(fs.readFileSync(about, 'utf8'), about),
        collection: 'about',
      });
  }
  const taxonomies = Object.fromEntries(
    Object.values(TAXONOMY_FIELDS).map((name) => {
      const directory = path.join(contentRoot, 'taxonomies', name);
      const values = fs.existsSync(directory)
        ? fs
            .readdirSync(directory)
            .filter((file) => /\.ya?ml$/u.test(file))
            .map((file) => path.basename(file).replace(/\.ya?ml$/u, ''))
        : [];
      return [name, new Set(values)];
    }),
  );
  const assetExists = (source, fromFile) => {
    const clean = decodeURIComponent(source.split(/[?#]/u)[0]);
    const target = clean.startsWith('@assets/')
      ? path.join(root, 'src/assets', clean.slice('@assets/'.length))
      : clean.startsWith('/')
        ? path.join(root, 'public', clean.slice(1))
        : path.resolve(path.dirname(fromFile), clean);
    return fs.existsSync(target);
  };
  return auditDocuments(documents, { taxonomies, assetExists });
}
