import { Octokit } from '@octokit/core';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { findStudioAssetReferencePaths, type StudioAssetSourceFile } from './studio-assets';

const repository = { owner: 'GM2020JLU', repo: 'GM-WEB', branch: 'main' } as const;
const sourceExtensions = new Set(['.md', '.mdx', '.yaml', '.yml', '.toml', '.json']);

function isReferenceSource(path: string) {
  if (path === 'src/config/site.toml') return true;
  if (!path.startsWith('src/content/')) return false;
  const dot = path.lastIndexOf('.');
  return dot >= 0 && sourceExtensions.has(path.slice(dot).toLocaleLowerCase('en-US'));
}

export type StudioTaxonomyField = 'categories' | 'series' | 'tags';

export class StudioReferenceConflictError extends Error {
  readonly status = 409;

  constructor(
    message: string,
    readonly code: 'ASSET_IN_USE' | 'TAXONOMY_IN_USE',
    readonly references: string[],
  ) {
    super(message);
    this.name = 'StudioReferenceConflictError';
  }
}

function frontmatter(content: string) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match) return undefined;
  const metadata = parse(match[1]) as unknown;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : undefined;
}

export function findStudioTaxonomyReferencePaths(
  files: StudioAssetSourceFile[],
  field: StudioTaxonomyField,
  value: string,
) {
  return files
    .filter((file) =>
      /^(?:src\/content\/(?:blog|projects|vibe|media)\/.*|src\/content\/about)\.mdx?$/u.test(
        file.path,
      ),
    )
    .filter((file) => {
      const metadata = frontmatter(file.content);
      return (
        Array.isArray(metadata?.[field]) && metadata[field].some((item) => String(item) === value)
      );
    })
    .map((file) => file.path)
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

async function localSources() {
  const contentRoot = resolve(process.cwd(), 'src/content');
  const files: StudioAssetSourceFile[] = [];
  const walk = async (relativeDirectory = '') => {
    let entries;
    try {
      entries = await readdir(resolve(contentRoot, relativeDirectory), { withFileTypes: true });
    } catch (error) {
      if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        if (entry.isDirectory()) return walk(relativePath);
        const sourcePath = `src/content/${relativePath}`;
        if (isReferenceSource(sourcePath)) {
          files.push({
            path: sourcePath,
            content: await readFile(resolve(contentRoot, relativePath), 'utf8'),
          });
        }
      }),
    );
  };
  await walk();
  try {
    const siteConfigPath = resolve(process.cwd(), 'src/config/site.toml');
    files.push({
      path: 'src/config/site.toml',
      content: await readFile(siteConfigPath, 'utf8'),
    });
  } catch (error) {
    if (!(typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
  return files;
}

async function githubSources(token: string) {
  const client = new Octokit({ auth: token, userAgent: 'goumin-work-studio' });
  const treeResponse = await client.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
    ...repository,
    tree_sha: repository.branch,
    recursive: '1',
    headers: { 'X-GitHub-Api-Version': '2022-11-28' },
  });
  const entries = ((treeResponse.data as any).tree as any[]).filter(
    (entry) => entry.type === 'blob' && entry.sha && isReferenceSource(String(entry.path)),
  );
  const files: StudioAssetSourceFile[] = [];
  for (let index = 0; index < entries.length; index += 8) {
    const batch = entries.slice(index, index + 8);
    files.push(
      ...(await Promise.all(
        batch.map(async (entry) => {
          const response = await client.request('GET /repos/{owner}/{repo}/git/blobs/{file_sha}', {
            owner: repository.owner,
            repo: repository.repo,
            file_sha: entry.sha,
            headers: { 'X-GitHub-Api-Version': '2022-11-28' },
          });
          const data = response.data as { content?: string; encoding?: string };
          const content =
            data.encoding === 'base64' && data.content
              ? Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8')
              : '';
          return { path: String(entry.path), content };
        }),
      )),
    );
  }
  return files;
}

export async function findStudioAssetReferences(assetPath: string, token?: string) {
  const files = token ? await githubSources(token) : await localSources();
  return findStudioAssetReferencePaths(files, assetPath);
}

export async function findStudioTaxonomyReferences(
  field: StudioTaxonomyField,
  value: string,
  token?: string,
) {
  const files = token ? await githubSources(token) : await localSources();
  return findStudioTaxonomyReferencePaths(files, field, value);
}
