import slugify from '@sindresorhus/slugify';
import { pinyin } from 'pinyin-pro';

export function generateStudioSlug(title: string) {
  const normalized = pinyin(title.trim(), {
    toneType: 'none',
    nonZh: 'consecutive',
    separator: ' ',
  });
  return slugify(normalized).slice(0, 64) || `untitled-${Date.now()}`;
}
