export type PublicationStatus = 'draft' | 'ready' | 'published';

export interface ContentHealthInput {
  collection: string;
  id: string;
  data: Record<string, unknown>;
  body?: string;
}

export function countWords(source = '') {
  const plain = source
    .replace(/^---[\s\S]*?---/u, '')
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/<[^>]+>|[#>*_`\[\]()!-]/gu, ' ');
  const latin = plain.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) ?? [];
  const cjk =
    plain.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? [];

  return latin.length + cjk.length;
}

export function estimateReadingMinutes(source = '') {
  const latin = source.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)?.length ?? 0;
  const cjk =
    source.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)
      ?.length ?? 0;

  return Math.max(1, Math.ceil(latin / 220 + cjk / 500));
}

export function getPublicationStatus(data: {
  publicationStatus?: string;
  draft?: boolean;
}): PublicationStatus {
  if (data.publicationStatus === 'ready' || data.publicationStatus === 'published') {
    return data.publicationStatus;
  }

  return data.draft ? 'draft' : 'published';
}

export function matchesContentFilters(
  item: { status?: string; type?: string; text?: string; health?: string },
  filters: { status: string; type: string; query: string },
) {
  const query = filters.query.trim().toLocaleLowerCase('zh-CN');
  const statusMatches =
    filters.status === 'all' ||
    (filters.status === 'issues' ? item.health === 'issues' : item.status === filters.status);
  return (
    statusMatches &&
    (filters.type === 'all' || item.type === filters.type) &&
    (!query || item.text?.toLocaleLowerCase('zh-CN').includes(query) === true)
  );
}

function hasText(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasItems(value: unknown) {
  return Array.isArray(value) && value.length > 0;
}

export function getContentHealth({ collection, id, data, body = '' }: ContentHealthInput) {
  const issues: string[] = [];
  const status = getPublicationStatus(data);
  const isProjectIndex = collection === 'projects' && id === 'index';

  if (!hasText(data.title)) issues.push('补充标题');
  if (['blog', 'projects', 'about'].includes(collection) && !hasText(data.description)) {
    issues.push('补充摘要');
  }
  if (collection !== 'media' && !data.date) issues.push('补充发布日期');
  if (status !== 'draft' && !data.updatedDate) issues.push('重新保存以写入更新时间');
  if (data.heroImage && !hasText(data.heroImageAlt)) issues.push('补充封面替代文本');
  if (!body.trim() && !hasItems(data.images) && !isProjectIndex) issues.push('补充正文');

  if (collection === 'blog' && !hasItems(data.categories) && !hasItems(data.tags)) {
    issues.push('选择分类或标签');
  }
  if (collection === 'projects' && !isProjectIndex) {
    if (!hasItems(data.links)) issues.push('补充项目链接');
    if (!hasItems(data.highlights)) issues.push('补充项目成果');
    if (!hasText(data.role)) issues.push('说明你的角色');
  }
  if (collection === 'media' && !hasText(data.creator)) issues.push('补充创作者');

  return issues;
}
