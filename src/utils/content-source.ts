import { existsSync, readdirSync } from 'node:fs';

export function hasContentFiles(collection: string) {
  const source = process.env.NAVFOLIO_CONTENT_SOURCE === 'docs' ? 'docs' : 'content';
  const directory = new URL(`../${source}/${collection}/`, import.meta.url);
  if (!existsSync(directory)) return false;

  return readdirSync(directory, { recursive: true }).some((file) =>
    /\.(?:md|mdx)$/u.test(String(file)),
  );
}
