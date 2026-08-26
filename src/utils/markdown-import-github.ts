import { Octokit } from '@octokit/core';

const repository = { owner: 'GM2020JLU', repo: 'GM-WEB', branch: 'main' } as const;
export const keystaticGitHubAppInstallUrl =
  'https://github.com/apps/gm2020jlu-keystatic/installations/new';

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

export class MarkdownImportPermissionError extends Error {
  actionLabel: string;
  actionUrl: string;

  constructor(message: string) {
    super(message);
    this.name = 'MarkdownImportPermissionError';
    this.actionLabel = '配置 GitHub App 仓库权限';
    this.actionUrl = keystaticGitHubAppInstallUrl;
  }
}

function statusFromError(error: unknown) {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}

function messageFromError(error: unknown) {
  if (typeof error !== 'object' || error === null) return '';
  if ('response' in error && typeof error.response === 'object' && error.response !== null) {
    const response = error.response;
    if ('data' in response && typeof response.data === 'object' && response.data !== null) {
      const data = response.data;
      if ('message' in data && typeof data.message === 'string') return data.message;
    }
  }
  return 'message' in error && typeof error.message === 'string' ? error.message : '';
}

function permissionError(error: unknown) {
  const githubMessage = messageFromError(error).toLocaleLowerCase('en-US');
  if (githubMessage.includes('resource not accessible by integration')) {
    return new MarkdownImportPermissionError(
      'Keystatic GitHub App 尚未安装到 GM-WEB，或安装时没有选择该仓库。',
    );
  }
  if (githubMessage.includes('protected branch')) {
    return new MarkdownImportPermissionError('GitHub 的 main 分支保护规则阻止了直接创建草稿。');
  }
  return new MarkdownImportPermissionError(
    '当前登录用户与 Keystatic GitHub App 的组合权限不足，二者都需要拥有 GM-WEB 写权限。',
  );
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
    if (statusFromError(error) === 403) throw permissionError(error);
    throw error;
  }
}
