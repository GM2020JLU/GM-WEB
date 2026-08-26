import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { frontmatter } from 'micromark-extension-frontmatter';
import { parseDocument, stringify } from 'yaml';

export const markdownImportCollections = ['blog', 'vibe', 'media'] as const;
export type MarkdownImportCollection = (typeof markdownImportCollections)[number];

export const MAX_MARKDOWN_IMPORT_BYTES = 1024 * 1024;

export interface MarkdownImportRequest {
  collection: MarkdownImportCollection;
  creator: string;
  description: string;
  filename: string;
  slug: string;
  source: string;
  title: string;
}

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  position?: { end?: { offset?: number } };
};

export interface MarkdownImportPreview {
  body: string;
  data: Record<string, unknown>;
  description: string;
  filename: string;
  slug: string;
  title: string;
  warnings: string[];
}

function textFromNode(node: MarkdownNode): string {
  if (typeof node.value === 'string') return node.value;
  return node.children?.map(textFromNode).join('') ?? '';
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function stringList(value: unknown) {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function dateValue(value: unknown, fallback: string) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString();
  const text = stringValue(value);
  return text && !Number.isNaN(new Date(text).valueOf()) ? text : fallback;
}

function firstParagraph(tree: MarkdownNode) {
  const paragraph = tree.children?.find((node) => node.type === 'paragraph');
  return paragraph ? textFromNode(paragraph).replace(/\s+/g, ' ').trim().slice(0, 180) : '';
}

function slugFromFilename(filename: string) {
  return filename
    .replace(/\.(?:md|markdown)$/i, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function parseYamlMatter(value: string) {
  const document = parseDocument(value, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length) throw document.errors[0];
  const data = document.toJS({ maxAliasCount: 0 });
  if (data === null || data === undefined) return {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Frontmatter 必须是键值对。');
  }
  return data as Record<string, unknown>;
}

export function parseMarkdownImport(filename: string, source: string): MarkdownImportPreview {
  if (!/\.md$/i.test(filename)) throw new Error('目前只支持 .md 文件。');
  if (!source.trim()) throw new Error('文件内容为空。');
  if (new TextEncoder().encode(source).byteLength > MAX_MARKDOWN_IMPORT_BYTES) {
    throw new Error('Markdown 文件不能超过 1 MB。');
  }

  const tree = fromMarkdown(source, {
    extensions: [frontmatter('yaml')],
    mdastExtensions: [frontmatterFromMarkdown('yaml')],
  }) as MarkdownNode;
  if (tree.children?.some((node) => node.type === 'html')) {
    throw new Error('导入内容不能包含原始 HTML，请改用标准 Markdown 语法。');
  }
  const matterNode = tree.children?.[0]?.type === 'yaml' ? tree.children[0] : undefined;
  const data = matterNode?.value ? parseYamlMatter(matterNode.value) : {};
  const bodyOffset = matterNode?.position?.end?.offset;
  const body = (bodyOffset === undefined ? source : source.slice(bodyOffset))
    .replace(/^\r?\n/, '')
    .trim();
  const heading = tree.children?.find((node) => node.type === 'heading');
  const title = stringValue(data.title) || (heading ? textFromNode(heading).trim() : '');
  const description =
    stringValue(data.description) || stringValue(data.summary) || firstParagraph(tree);
  const warnings: string[] = [];

  if (!matterNode) warnings.push('未发现 YAML frontmatter，已尝试从正文提取标题和摘要。');
  if (!title) warnings.push('未识别到标题，导入前需要手动填写。');
  if (!description) warnings.push('未识别到摘要，博客导入前需要手动填写。');
  if (!body) warnings.push('正文为空，可以先作为草稿导入。');

  return {
    body,
    data,
    description,
    filename,
    slug: stringValue(data.slug) || slugFromFilename(filename),
    title,
    warnings,
  };
}

function chinaIsoDateTime(now: Date) {
  const china = new Date(now.valueOf() + 8 * 60 * 60 * 1000);
  return `${china.toISOString().slice(0, 19)}+08:00`;
}

export function createImportedMarkdown(
  input: MarkdownImportRequest,
  now = new Date(),
): { content: string; path: string; warnings: string[] } {
  const request = input;
  const parsed = parseMarkdownImport(request.filename, request.source);
  const timestamp = chinaIsoDateTime(now);
  const original = parsed.data;
  let frontmatterData: Record<string, unknown>;
  const warnings = [...parsed.warnings];

  if (request.collection === 'blog') {
    frontmatterData = {
      title: request.title,
      description: request.description,
      date: dateValue(original.date, timestamp),
      updatedDate: timestamp,
      publicationStatus: 'draft',
      draft: true,
      showHeroImage: false,
      tags: stringList(original.tags),
      categories: stringList(original.categories),
      series: stringList(original.series),
      comments: true,
      sidebar: { enable: true, toc: true, relatedPosts: true },
    };
  } else if (request.collection === 'vibe') {
    frontmatterData = {
      title: request.title,
      date: dateValue(original.date, timestamp),
      updatedDate: timestamp,
      publicationStatus: 'draft',
      draft: true,
      type: ['text', 'photo', 'quote', 'code', 'mixed'].includes(stringValue(original.type))
        ? stringValue(original.type)
        : 'text',
      mood: stringValue(original.mood),
      location: stringValue(original.location),
      images: [],
      tags: stringList(original.tags),
      align: ['left', 'right', 'center'].includes(stringValue(original.align))
        ? stringValue(original.align)
        : 'left',
      size: ['sm', 'md', 'lg'].includes(stringValue(original.size))
        ? stringValue(original.size)
        : 'md',
    };
  } else {
    if (!request.creator) throw new Error('导入书影音时必须填写创作者。');
    frontmatterData = {
      title: request.title,
      creator: request.creator,
      publicationStatus: 'draft',
      draft: true,
      updatedDate: timestamp,
      type: ['book', 'film', 'series', 'album', 'podcast'].includes(stringValue(original.type))
        ? stringValue(original.type)
        : 'book',
      status: ['completed', 'in-progress', 'planned', 'abandoned'].includes(
        stringValue(original.status),
      )
        ? stringValue(original.status)
        : 'planned',
      tags: stringList(original.tags),
      review: Boolean(original.review),
    };
  }

  const ignoredKeys = ['publicationStatus', 'draft', 'updatedDate'].filter(
    (key) => key in original,
  );
  if (ignoredKeys.length) warnings.push('原发布状态和更新时间已被安全的草稿值替换。');

  return {
    content: `---\n${stringify(frontmatterData, { lineWidth: 0 })}---\n${parsed.body ? `\n${parsed.body}\n` : ''}`,
    path: `src/content/${request.collection}/${request.slug}.md`,
    warnings,
  };
}
