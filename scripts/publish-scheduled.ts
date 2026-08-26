import { readFile, writeFile } from 'node:fs/promises';
import {
  isScheduledPublicationDue,
  parseStudioDocument,
  serializeStudioDocument,
  type StudioCollection,
} from '../src/utils/studio-content';

const roots: Array<{ collection: StudioCollection; pattern: string }> = [
  { collection: 'blog', pattern: 'src/content/blog/*.{md,mdx}' },
  { collection: 'projects', pattern: 'src/content/projects/*.{md,mdx}' },
  { collection: 'vibe', pattern: 'src/content/vibe/*.{md,mdx}' },
  { collection: 'media', pattern: 'src/content/media/*.{md,mdx}' },
  { collection: 'about', pattern: 'src/content/about.{md,mdx}' },
];

let published = 0;
for (const root of roots) {
  const glob = new Bun.Glob(root.pattern);
  for await (const path of glob.scan({ cwd: process.cwd(), absolute: false, onlyFiles: true })) {
    const slug =
      root.collection === 'about'
        ? 'about'
        : path
            .split('/')
            .at(-1)!
            .replace(/\.(md|mdx)$/, '');
    const source = await readFile(path, 'utf8');
    const document = parseStudioDocument(root.collection, slug, source);
    if (!isScheduledPublicationDue(document.metadata)) continue;
    const metadata = { ...document.metadata };
    delete metadata.scheduledAt;
    await writeFile(
      path,
      serializeStudioDocument(root.collection, slug, metadata, document.body, 'published'),
      'utf8',
    );
    published++;
    console.log(`Published scheduled content: ${root.collection}/${slug}`);
  }
}

console.log(`Scheduled publishing complete: ${published} item(s).`);
