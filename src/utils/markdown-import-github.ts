import { Octokit } from '@octokit/core';

const repository = { owner: 'GM2020JLU', repo: 'GM-WEB', branch: 'main' } as const;

type GitHubRequest = (
  route: string,
  parameters: Record<string, unknown>,
) => Promise<{ data?: unknown }>;

export class MarkdownImportConflictError extends Error {
  constructor(path: string) {
    super(`内容已存在：${path}`);
    this.name = 'MarkdownImportConflictError';
  }
}

function statusFromError(error: unknown) {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}

export async function createGitHubMarkdownFile(
  args: { token: string; path: string; content: string },
  request?: GitHubRequest,
) {
  const githubRequest =
    request ?? new Octokit({ auth: args.token, userAgent: 'goumin-work-markdown-import' }).request;
  const common = { ...repository, path: args.path };

  try {
    await githubRequest('GET /repos/{owner}/{repo}/contents/{path}', common);
    throw new MarkdownImportConflictError(args.path);
  } catch (error) {
    if (error instanceof MarkdownImportConflictError) throw error;
    if (statusFromError(error) !== 404) throw error;
  }

  try {
    const result = await githubRequest('PUT /repos/{owner}/{repo}/contents/{path}', {
      ...common,
      branch: repository.branch,
      message: `Import Markdown draft: ${args.path}`,
      content: Buffer.from(args.content, 'utf8').toString('base64'),
      headers: { 'X-GitHub-Api-Version': '2022-11-28' },
    });
    return result.data;
  } catch (error) {
    if (statusFromError(error) === 409 || statusFromError(error) === 422) {
      throw new MarkdownImportConflictError(args.path);
    }
    throw error;
  }
}
