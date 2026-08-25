export type PublicationStatus = 'draft' | 'ready' | 'published';

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
  item: { status?: string; type?: string; text?: string },
  filters: { status: string; type: string; query: string },
) {
  const query = filters.query.trim().toLocaleLowerCase('zh-CN');
  return (
    (filters.status === 'all' || item.status === filters.status) &&
    (filters.type === 'all' || item.type === filters.type) &&
    (!query || item.text?.toLocaleLowerCase('zh-CN').includes(query) === true)
  );
}
