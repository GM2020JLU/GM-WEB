import { existsSync } from 'node:fs';
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { auditDocuments, parseDocument as parseAuditDocument } from './lib/content-audit.mjs';
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

type PlannedPublication = {
  collection: StudioCollection;
  content: string;
  path: string;
  previousContent: string;
  slug: string;
};

async function readTaxonomies(repositoryRoot: string) {
  return Object.fromEntries(
    await Promise.all(
      (['tags', 'categories', 'series'] as const).map(async (name) => {
        const directory = join(repositoryRoot, 'src/content/taxonomies', name);
        let files: string[] = [];
        try {
          files = await readdir(directory);
        } catch (error) {
          if (!(typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT')) {
            throw error;
          }
        }
        return [
          name,
          new Set(
            files
              .filter((file) => /\.ya?ml$/u.test(file))
              .map((file) => basename(file).replace(/\.ya?ml$/u, '')),
          ),
        ];
      }),
    ),
  ) as Record<'tags' | 'categories' | 'series', Set<string>>;
}

function assetExists(repositoryRoot: string, source: string, fromFile: string) {
  let clean: string;
  try {
    clean = decodeURIComponent(source.split(/[?#]/u)[0]);
  } catch {
    return false;
  }

  const target = clean.startsWith('@assets/')
    ? join(repositoryRoot, 'src/assets', clean.slice('@assets/'.length))
    : clean.startsWith('/')
      ? join(repositoryRoot, 'public', clean.slice(1))
      : resolve(dirname(fromFile), clean);
  return existsSync(target);
}

async function planScheduledPublications(repositoryRoot: string, now: Date) {
  const planned: PlannedPublication[] = [];

  for (const definition of roots) {
    const glob = new Bun.Glob(definition.pattern);
    for await (const path of glob.scan({
      cwd: repositoryRoot,
      absolute: false,
      onlyFiles: true,
    })) {
      const slug =
        definition.collection === 'about' ? 'about' : basename(path).replace(/\.(md|mdx)$/u, '');
      const source = await readFile(join(repositoryRoot, path), 'utf8');
      const document = parseStudioDocument(definition.collection, slug, source);
      if (!isScheduledPublicationDue(document.metadata, now)) continue;

      const metadata = { ...document.metadata };
      delete metadata.scheduledAt;
      planned.push({
        collection: definition.collection,
        content: serializeStudioDocument(
          definition.collection,
          slug,
          metadata,
          document.body,
          'published',
        ),
        path,
        previousContent: source,
        slug,
      });
    }
  }

  return planned;
}

async function writePlannedContent(
  repositoryRoot: string,
  planned: PlannedPublication[],
  content: (item: PlannedPublication) => string,
) {
  for (const item of planned) {
    const target = join(repositoryRoot, item.path);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporary, content(item), { encoding: 'utf8', flag: 'wx', mode: 0o644 });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export async function publishScheduledContent(
  repositoryRoot = process.cwd(),
  now = new Date(),
  afterWrite?: (planned: PlannedPublication[]) => Promise<void>,
) {
  const planned = await planScheduledPublications(repositoryRoot, now);
  if (!planned.length) return [];

  const taxonomies = await readTaxonomies(repositoryRoot);
  const documents = planned.map((item) => ({
    ...parseAuditDocument(item.content, join(repositoryRoot, item.path)),
    collection: item.collection,
  }));
  const blockingIssues = auditDocuments(documents, {
    taxonomies,
    assetExists: (source: string, fromFile: string) =>
      assetExists(repositoryRoot, source, fromFile),
  }).filter((issue: { level: string }) => issue.level === 'error');

  if (blockingIssues.length) {
    const detail = blockingIssues
      .map((issue: { file: string; message: string }) => `${issue.file}: ${issue.message}`)
      .join('\n');
    throw new Error(`定时发布预检失败，未修改任何文件：\n${detail}`);
  }

  try {
    await writePlannedContent(repositoryRoot, planned, (item) => item.content);
    await afterWrite?.(planned);
  } catch (error) {
    // A scheduled item must never become published without a durable deployment
    // request. Restore the ready documents so the next launchd run can retry.
    await writePlannedContent(repositoryRoot, planned, (item) => item.previousContent);
    throw error;
  }
  return planned;
}

if (import.meta.main) {
  try {
    const published = await publishScheduledContent();
    for (const item of published) {
      console.log(`Published scheduled content: ${item.collection}/${item.slug}`);
    }
    console.log(`Scheduled publishing complete: ${published.length} item(s).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
