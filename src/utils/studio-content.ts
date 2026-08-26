import { parseDocument, stringify } from 'yaml';
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

const slugSchema = z
  .string()
  .trim()
  .min(1, '网址别名不能为空。')
  .max(80, '网址别名不能超过 80 个字符。')
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, '网址别名只能使用小写英文、数字和中划线。');

export const studioWriteSchema = z.object({
  action: z.enum(['draft', 'ready', 'publish', 'unpublish', 'schedule']).optional(),
  body: z.string().max(2 * 1024 * 1024, '正文不能超过 2 MB。'),
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
    ['blog', 'projects', 'vibe', 'about'].includes(collection) &&
    (!metadata.date || Number.isNaN(new Date(String(metadata.date)).valueOf()))
  ) {
    errors.push('待发布或已发布内容必须填写有效日期。');
  }
  if (errors.length) throw new Error(errors.join(' '));
}

export function serializeStudioDocument(
  collection: StudioCollection,
  slug: string,
  metadata: Record<string, unknown>,
  body: string,
  status?: StudioPublicationStatus,
) {
  if (isTaxonomyCollection(collection)) {
    validateStudioDocument(collection, slug, metadata, 'published');
    const { publicationStatus: _publicationStatus, draft: _draft, ...taxonomy } = metadata;
    return stringify(cleanMetadata(taxonomy), { lineWidth: 0 });
  }

  const publicationStatus =
    status ??
    (['draft', 'ready', 'published'].includes(String(metadata.publicationStatus))
      ? (metadata.publicationStatus as StudioPublicationStatus)
      : 'draft');
  const next = cleanMetadata({
    ...metadata,
    updatedDate: chinaIsoDateTime(),
    publicationStatus,
    draft: publicationStatus !== 'published',
  });
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
