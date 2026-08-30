import { parseDocument, stringify } from 'yaml';
import { posix } from 'node:path';
import { z } from 'zod';

export const studioCollections = [
  'blog',
  'projects',
  'vibe',
  'media',
  'about',
  'categories',
  'series',
  'tags',
] as const;

export type StudioCollection = (typeof studioCollections)[number];
export type StudioPublicationStatus = 'draft' | 'ready' | 'published';

export interface StudioDocument {
  body: string;
  collection: StudioCollection;
  metadata: Record<string, unknown>;
  path: string;
  sha?: string;
  slug: string;
}

export class StudioValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StudioValidationError';
  }
}

const sharedArticleFields = [
  'title',
  'description',
  'date',
  'updatedDate',
  'publicationStatus',
  'scheduledAt',
  'draft',
  'sticky',
  'heroImage',
  'heroImageAlt',
  'showHeroImage',
  'tags',
  'categories',
  'series',
  'comments',
  'sidebar',
] as const;

const allowedMetadataFields: Record<StudioCollection, ReadonlySet<string>> = {
  blog: new Set(sharedArticleFields),
  projects: new Set([
    ...sharedArticleFields,
    'icon',
    'iconColor',
    'role',
    'period',
    'highlights',
    'authors',
    'links',
  ]),
  about: new Set(sharedArticleFields),
  vibe: new Set([
    'title',
    'date',
    'updatedDate',
    'publicationStatus',
    'scheduledAt',
    'draft',
    'type',
    'mood',
    'location',
    'images',
    'tags',
    'align',
    'size',
  ]),
  media: new Set([
    'title',
    'creator',
    'type',
    'status',
    'completedAt',
    'publicationStatus',
    'scheduledAt',
    'updatedDate',
    'draft',
    'cover',
    'coverAspect',
    'rating',
    'review',
    'tags',
    'externalUrl',
  ]),
  categories: new Set(['title', 'description']),
  series: new Set(['title', 'description']),
  tags: new Set(['title', 'description']),
};

const collectionLabels: Record<StudioCollection, string> = {
  blog: '博客文章',
  projects: '项目案例',
  vibe: '随记',
  media: '书影音',
  about: '关于页',
  categories: '分类',
  series: '系列',
  tags: '标签',
};

const fieldLabels: Record<string, string> = {
  description: '摘要',
  creator: '创作者',
  date: '发布时间',
  type: '内容类型',
  status: '阅读/观看进度',
  categories: '分类',
  series: '系列',
};

const placeholderPattern =
  /\b(?:lorem|ipsum|test)\b|(?:casdcv|scvasdv|asdf{2,}|测试内容|占位内容)/iu;
const markdownImagePattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+['"][^'"]*['"])?\)/gu;

export interface StudioImageReference {
  label: string;
  source: string;
}

export function studioImageReferences(metadata: Record<string, unknown>, body: string) {
  const references: StudioImageReference[] = [];
  for (const match of body.matchAll(markdownImagePattern)) {
    references.push({ label: '正文图片', source: match[2] });
  }
  for (const key of ['heroImage', 'cover'] as const) {
    if (typeof metadata[key] === 'string' && metadata[key]) {
      references.push({ label: key, source: metadata[key] });
    }
  }
  for (const source of Array.isArray(metadata.images) ? metadata.images : []) {
    if (typeof source === 'string' && source) references.push({ label: 'images', source });
  }
  return references;
}

export function studioRepositoryImagePath(source: string, contentPath: string) {
  if (/^https?:\/\//iu.test(source)) return undefined;
  let clean: string;
  try {
    clean = decodeURIComponent(source.split(/[?#]/u)[0]).replaceAll('\\', '/');
  } catch {
    throw new StudioValidationError(`图片路径无法解码：${source}`);
  }
  if (!clean) throw new StudioValidationError('图片路径不能为空。');
  const repositoryPath = clean.startsWith('@assets/')
    ? posix.normalize(`src/assets/${clean.slice('@assets/'.length)}`)
    : clean.startsWith('/')
      ? posix.normalize(`public/${clean.slice(1)}`)
      : posix.normalize(posix.join(posix.dirname(contentPath), clean));
  if (
    repositoryPath === '..' ||
    repositoryPath.startsWith('../') ||
    (clean.startsWith('@assets/') && !repositoryPath.startsWith('src/assets/')) ||
    (clean.startsWith('/') && !repositoryPath.startsWith('public/'))
  ) {
    throw new StudioValidationError(`图片路径越出内容仓库：${source}`);
  }
  return repositoryPath;
}

export async function validateStudioImageReferences(
  metadata: Record<string, unknown>,
  body: string,
  status: StudioPublicationStatus,
  contentPath: string,
  exists: (repositoryPath: string) => boolean | Promise<boolean>,
) {
  if (status === 'draft') return;
  const missing: string[] = [];
  for (const reference of studioImageReferences(metadata, body)) {
    const repositoryPath = studioRepositoryImagePath(reference.source, contentPath);
    if (repositoryPath && !(await exists(repositoryPath))) {
      missing.push(`${reference.label} 文件不存在：${reference.source}`);
    }
  }
  if (missing.length) throw new StudioValidationError(missing.join(' '));
}

function validateStudioPublicationBody(
  metadata: Record<string, unknown>,
  body: string,
  status: StudioPublicationStatus,
) {
  if (status === 'draft') return;
  const errors: string[] = [];
  if (placeholderPattern.test(`${metadata.title ?? ''}\n${metadata.description ?? ''}\n${body}`)) {
    errors.push('检测到测试或占位内容。');
  }
  if (metadata.heroImage && !String(metadata.heroImageAlt ?? '').trim()) {
    errors.push('封面图缺少替代文本。');
  }
  for (const [alt, source] of [...body.matchAll(markdownImagePattern)].map((match) => [
    match[1],
    match[2],
  ])) {
    if (!alt.trim()) errors.push(`正文图片缺少替代文本：${source}`);
  }
  if (errors.length) throw new StudioValidationError(errors.join(' '));
}

function validateStudioMetadataFields(
  collection: StudioCollection,
  metadata: Record<string, unknown>,
) {
  const unsupported = Object.keys(metadata).filter(
    (key) => !allowedMetadataFields[collection].has(key),
  );
  if (unsupported.length) {
    const fields = unsupported
      .map((key) => `“${key}${fieldLabels[key] ? `（${fieldLabels[key]}）` : ''}”`)
      .join('、');
    throw new StudioValidationError(
      `${collectionLabels[collection]}不支持字段 ${fields}。请检查字段名称，或改用对应的内容模块。`,
    );
  }

  const stringFields = [
    'title',
    'description',
    'date',
    'updatedDate',
    'scheduledAt',
    'creator',
    'mood',
    'location',
    'heroImageAlt',
    'iconColor',
    'role',
    'period',
    'completedAt',
    'coverAspect',
    'externalUrl',
  ];
  const wrongString = stringFields.find(
    (key) => key in metadata && typeof metadata[key] !== 'string',
  );
  if (wrongString) {
    throw new StudioValidationError(`字段“${wrongString}”应填写文字，当前值类型不正确。`);
  }
  const listFields = ['tags', 'categories', 'series', 'images', 'highlights', 'authors', 'links'];
  const wrongList = listFields.find((key) => key in metadata && !Array.isArray(metadata[key]));
  if (wrongList) {
    throw new StudioValidationError(`字段“${wrongList}”应为列表，请检查填写格式。`);
  }
  const booleanFields = ['draft', 'showHeroImage', 'comments', 'review'];
  const wrongBoolean = booleanFields.find(
    (key) => key in metadata && typeof metadata[key] !== 'boolean',
  );
  if (wrongBoolean) {
    throw new StudioValidationError(`字段“${wrongBoolean}”只能填写开启或关闭。`);
  }

  const enumFields: Record<string, readonly string[]> = {
    publicationStatus: ['draft', 'ready', 'published'],
    type:
      collection === 'media'
        ? ['book', 'film', 'series', 'album', 'podcast']
        : ['text', 'photo', 'quote', 'code', 'mixed'],
    status: ['completed', 'in-progress', 'planned', 'abandoned'],
    align: ['left', 'right', 'center'],
    size: ['sm', 'md', 'lg'],
    coverAspect: ['portrait', 'landscape', 'square', 'wide'],
  };
  for (const [key, values] of Object.entries(enumFields)) {
    if (key in metadata && !values.includes(String(metadata[key]))) {
      throw new StudioValidationError(
        `字段“${key}”的值“${String(metadata[key])}”无效，可用值：${values.join('、')}。`,
      );
    }
  }
  if (
    'rating' in metadata &&
    (typeof metadata.rating !== 'number' || metadata.rating < 1 || metadata.rating > 5)
  ) {
    throw new StudioValidationError('字段“rating（评分）”必须是 1 到 5 之间的数字。');
  }
}

const slugSchema = z
  .string()
  .trim()
  .min(1, '网址别名不能为空。')
  .max(80, '网址别名不能超过 80 个字符。')
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, '网址别名只能使用小写英文、数字和中划线。');

export const studioWriteSchema = z.object({
  action: z.enum(['draft', 'ready', 'publish', 'unpublish', 'schedule']).optional(),
  body: z.string().max(2 * 1024 * 1024, '正文不能超过 2 MB。'),
  expectedSha: z
    .string()
    .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i, '内容版本标识不合法。')
    .optional(),
  metadata: z.record(z.string(), z.unknown()),
  originalSlug: z.string().optional(),
  slug: z.string().optional().default(''),
});

export function isStudioCollection(value: string): value is StudioCollection {
  return studioCollections.includes(value as StudioCollection);
}

export function isTaxonomyCollection(collection: StudioCollection) {
  return collection === 'categories' || collection === 'series' || collection === 'tags';
}

export function studioContentPath(collection: StudioCollection, slug: string) {
  if (collection === 'about') return 'src/content/about.mdx';
  if (isTaxonomyCollection(collection)) {
    const safeName = slug.trim().replace(/[\\/]/g, '-').slice(0, 80);
    if (!safeName || safeName === '.' || safeName === '..') throw new Error('内容标识不合法。');
    return `src/content/taxonomies/${collection}/${safeName}.yaml`;
  }
  const safeSlug = slugSchema.parse(slug);
  const extension = collection === 'projects' ? 'mdx' : 'md';
  return `src/content/${collection}/${safeSlug}.${extension}`;
}

export function parseStudioDocument(
  collection: StudioCollection,
  slug: string,
  source: string,
  sha?: string,
): StudioDocument {
  const path = studioContentPath(collection, slug);
  if (isTaxonomyCollection(collection)) {
    const document = parseDocument(source, { prettyErrors: true, strict: true, uniqueKeys: true });
    if (document.errors.length) throw document.errors[0];
    const value = document.toJS({ maxAliasCount: 0 });
    return {
      body: '',
      collection,
      metadata:
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {},
      path,
      sha,
      slug,
    };
  }

  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const frontmatter = match?.[1] ?? '';
  const document = parseDocument(frontmatter, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length) throw document.errors[0];
  const value = frontmatter ? document.toJS({ maxAliasCount: 0 }) : {};
  return {
    body: match ? source.slice(match[0].length) : source,
    collection,
    metadata:
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {},
    path,
    sha,
    slug,
  };
}

function chinaIsoDateTime(now = new Date()) {
  const china = new Date(now.valueOf() + 8 * 60 * 60 * 1000);
  return `${china.toISOString().slice(0, 19)}+08:00`;
}

function cleanMetadata(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== ''),
  );
}

export function validateStudioDocument(
  collection: StudioCollection,
  slug: string,
  metadata: Record<string, unknown>,
  status: StudioPublicationStatus,
) {
  studioContentPath(collection, slug);
  validateStudioMetadataFields(collection, metadata);
  const errors: string[] = [];
  if (typeof metadata.title !== 'string' || !metadata.title.trim()) errors.push('请填写标题。');
  if (collection === 'media' && (!metadata.creator || typeof metadata.creator !== 'string')) {
    errors.push('书影音内容必须填写创作者。');
  }
  if (
    status !== 'draft' &&
    ['blog', 'projects', 'about'].includes(collection) &&
    (typeof metadata.description !== 'string' || !metadata.description.trim())
  ) {
    errors.push('待发布或已发布内容必须填写摘要。');
  }
  if (
    status !== 'draft' &&
    ['blog', 'projects', 'about'].includes(collection) &&
    typeof metadata.description === 'string' &&
    metadata.description.replace(/\s/g, '').length < 12
  ) {
    errors.push('摘要过短，请用至少 12 个字符说明内容重点。');
  }
  if (
    status !== 'draft' &&
    ['blog', 'projects', 'vibe', 'about'].includes(collection) &&
    (!metadata.date || Number.isNaN(new Date(String(metadata.date)).valueOf()))
  ) {
    errors.push('待发布或已发布内容必须填写有效日期。');
  }
  if (errors.length) throw new StudioValidationError(errors.join(' '));
}

export function validateStudioTaxonomyReferences(
  metadata: Record<string, unknown>,
  taxonomies: Record<'categories' | 'series' | 'tags', Set<string>>,
) {
  const errors: string[] = [];
  for (const field of ['categories', 'series', 'tags'] as const) {
    for (const value of Array.isArray(metadata[field]) ? metadata[field] : []) {
      if (!taxonomies[field].has(String(value))) errors.push(`${field}：${value}`);
    }
  }
  if (errors.length) {
    throw new StudioValidationError(`请先在“分类”中登记这些内容组织项：${errors.join('、')}。`);
  }
}

export function serializeStudioDocument(
  collection: StudioCollection,
  slug: string,
  metadata: Record<string, unknown>,
  body: string,
  status?: StudioPublicationStatus,
) {
  if (isTaxonomyCollection(collection)) {
    const { publicationStatus: _publicationStatus, draft: _draft, ...taxonomy } = metadata;
    validateStudioDocument(collection, slug, taxonomy, 'published');
    return stringify(cleanMetadata(taxonomy), { lineWidth: 0 });
  }

  const publicationStatus =
    status ??
    (['draft', 'ready', 'published'].includes(String(metadata.publicationStatus))
      ? (metadata.publicationStatus as StudioPublicationStatus)
      : 'draft');
  const next = cleanMetadata({
    ...metadata,
    scheduledAt: publicationStatus === 'published' ? undefined : metadata.scheduledAt,
    updatedDate: chinaIsoDateTime(),
    publicationStatus,
    draft: publicationStatus !== 'published',
  });
  validateStudioPublicationBody(next, body, publicationStatus);
  const bodyLength = body.replace(/\s/g, '').length;
  if (publicationStatus !== 'draft' && ['blog', 'projects', 'vibe', 'about'].includes(collection)) {
    if (!bodyLength) throw new StudioValidationError('待发布或已发布内容必须填写正文。');
    if (collection === 'vibe' && bodyLength > 1600) {
      throw new StudioValidationError(
        `这篇随记有 ${bodyLength.toLocaleString('zh-CN')} 个字符，已经超出短内容范围，请改用“博客文章”模块。`,
      );
    }
  }
  validateStudioDocument(collection, slug, next, publicationStatus);
  return `---\n${stringify(next, { lineWidth: 0 })}---\n${body.trim() ? `\n${body.trim()}\n` : ''}`;
}

export function defaultStudioMetadata(collection: StudioCollection) {
  const timestamp = chinaIsoDateTime();
  if (isTaxonomyCollection(collection)) return { title: '', description: '' };
  const common = {
    title: '',
    date: timestamp,
    updatedDate: timestamp,
    publicationStatus: 'draft',
    draft: true,
  };
  if (collection === 'vibe') {
    return { ...common, type: 'text', images: [], tags: [], align: 'left', size: 'md' };
  }
  if (collection === 'media') {
    return {
      ...common,
      creator: '',
      type: 'book',
      status: 'planned',
      tags: [],
      review: false,
    };
  }
  return {
    ...common,
    description: '',
    showHeroImage: false,
    tags: [],
    categories: [],
    series: [],
    comments: true,
    sidebar: { enable: true, toc: true, relatedPosts: true },
  };
}

export function studioPublicUrl(collection: StudioCollection, slug: string) {
  if (collection === 'blog') return `/blog/${slug}`;
  if (collection === 'projects') return slug === 'index' ? '/projects' : `/projects/${slug}`;
  if (collection === 'vibe') return '/vibe';
  if (collection === 'media') return '/media';
  if (collection === 'about') return '/about';
  return undefined;
}

export function isScheduledPublicationDue(metadata: Record<string, unknown>, now = new Date()) {
  if (metadata.publicationStatus !== 'ready' || typeof metadata.scheduledAt !== 'string') {
    return false;
  }
  const scheduledAt = new Date(metadata.scheduledAt);
  return !Number.isNaN(scheduledAt.valueOf()) && scheduledAt.valueOf() <= now.valueOf();
}
