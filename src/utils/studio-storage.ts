import { Octokit } from '@octokit/core';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { resolveStudioDeploymentPhase } from './studio-deployment';

const repository = { owner: 'GM2020JLU', repo: 'GM-WEB', branch: 'main' } as const;

type GitHubContent = { content?: string; encoding?: string; sha?: string; type?: string };

export interface StudioStoredFile {
  content: string;
  path: string;
  sha?: string;
}

export interface StudioHistoryEntry {
  author: string;
  date: string;
  message: string;
  sha: string;
  url: string;
}

export interface StudioAsset {
  name: string;
  path: string;
  sha?: string;
  size: number;
  url: string;
}

export class StudioConflictError extends Error {
  constructor(message = '内容已被其他操作修改，请刷新后重试。') {
    super(message);
    this.name = 'StudioConflictError';
  }
}

function decodeContent(data: GitHubContent) {
  if (data.type !== 'file' || !data.content) throw new Error('GitHub 返回的内容不是文件。');
  return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
}

function github(token: string) {
  return new Octokit({ auth: token, userAgent: 'goumin-work-studio' });
}

function publicOrAuthenticatedGitHub(token?: string) {
  return token ? github(token) : new Octokit({ userAgent: 'goumin-work-studio' });
}

export async function readStudioFile(path: string, token?: string): Promise<StudioStoredFile> {
  if (!token) return { path, content: await readFile(resolve(process.cwd(), path), 'utf8') };
  const response = await github(token).request('GET /repos/{owner}/{repo}/contents/{path}', {
    ...repository,
    path,
    ref: repository.branch,
    headers: { 'X-GitHub-Api-Version': '2022-11-28' },
  });
  const data = response.data as GitHubContent;
  return { path, content: decodeContent(data), sha: data.sha };
}

export async function writeStudioFile(args: {
  content: string;
  message: string;
  path: string;
  previousPath?: string;
  sha?: string;
  token?: string;
}) {
  if (!args.token) {
    const target = resolve(process.cwd(), args.path);
    await mkdir(dirname(target), { recursive: true });
    if (args.previousPath && args.previousPath !== args.path) {
      await rename(resolve(process.cwd(), args.previousPath), target);
    }
    await writeFile(target, args.content, 'utf8');
    return { path: args.path, commitSha: undefined };
  }

  const client = github(args.token);
  try {
    const response = await client.request('PUT /repos/{owner}/{repo}/contents/{path}', {
      ...repository,
      path: args.path,
      branch: repository.branch,
      message: args.message,
      content: Buffer.from(args.content, 'utf8').toString('base64'),
      ...(args.sha ? { sha: args.sha } : {}),
      headers: { 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (args.previousPath && args.previousPath !== args.path) {
      const previous = await readStudioFile(args.previousPath, args.token);
      await client.request('DELETE /repos/{owner}/{repo}/contents/{path}', {
        ...repository,
        path: args.previousPath,
        branch: repository.branch,
        message: `Move content to ${args.path}`,
        sha: previous.sha!,
        headers: { 'X-GitHub-Api-Version': '2022-11-28' },
      });
    }
    const data = response.data as { commit?: { sha?: string }; content?: { sha?: string } };
    return {
      path: args.path,
      commitSha: data.commit?.sha,
      contentSha: data.content?.sha,
    };
  } catch (error) {
    if (typeof error === 'object' && error && 'status' in error && error.status === 409) {
      throw new StudioConflictError();
    }
    throw error;
  }
}

export async function writeStudioBinaryFile(args: {
  content: Buffer;
  message: string;
  path: string;
  token?: string;
}) {
  if (!args.token) {
    const target = resolve(process.cwd(), args.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, args.content);
    return { path: args.path };
  }
  return github(args.token).request('PUT /repos/{owner}/{repo}/contents/{path}', {
    ...repository,
    path: args.path,
    branch: repository.branch,
    message: args.message,
    content: args.content.toString('base64'),
    headers: { 'X-GitHub-Api-Version': '2022-11-28' },
  });
}

export async function deleteStudioFile(path: string, sha: string | undefined, token?: string) {
  if (!token) {
    await unlink(resolve(process.cwd(), path));
    return;
  }
  if (!sha) throw new StudioConflictError('缺少内容版本，请刷新后再删除。');
  await github(token).request('DELETE /repos/{owner}/{repo}/contents/{path}', {
    ...repository,
    path,
    branch: repository.branch,
    message: `Delete content: ${path}`,
    sha,
    headers: { 'X-GitHub-Api-Version': '2022-11-28' },
  });
}

export async function listStudioHistory(
  path: string,
  token?: string,
): Promise<StudioHistoryEntry[]> {
  if (!token) return [];
  const response = await github(token).request('GET /repos/{owner}/{repo}/commits', {
    ...repository,
    path,
    per_page: 30,
    headers: { 'X-GitHub-Api-Version': '2022-11-28' },
  });
  return (response.data as any[]).map((entry) => ({
    sha: entry.sha,
    message: entry.commit?.message ?? '内容更新',
    date: entry.commit?.author?.date ?? '',
    author: entry.commit?.author?.name ?? entry.author?.login ?? 'GitHub',
    url: entry.html_url,
  }));
}

export async function readStudioFileAtRef(path: string, ref: string, token: string) {
  const response = await github(token).request('GET /repos/{owner}/{repo}/contents/{path}', {
    ...repository,
    path,
    ref,
    headers: { 'X-GitHub-Api-Version': '2022-11-28' },
  });
  return decodeContent(response.data as GitHubContent);
}

export async function getStudioDeployment(token?: string, targetSha?: string, runtimeSha?: string) {
  const client = publicOrAuthenticatedGitHub(token);
  const [commit, deployments] = await Promise.all([
    client.request('GET /repos/{owner}/{repo}/commits/{ref}', {
      ...repository,
      ref: repository.branch,
      headers: { 'X-GitHub-Api-Version': '2022-11-28' },
    }),
    client.request('GET /repos/{owner}/{repo}/deployments', {
      ...repository,
      ref: repository.branch,
      per_page: 10,
      headers: { 'X-GitHub-Api-Version': '2022-11-28' },
    }),
  ]);
  const allDeployments = deployments.data as any[];
  const latest = targetSha
    ? (allDeployments.find((deployment) => deployment.sha === targetSha) ?? allDeployments[0])
    : allDeployments[0];
  let status: any;
  if (latest) {
    const result = await client.request(
      'GET /repos/{owner}/{repo}/deployments/{deployment_id}/statuses',
      {
        ...repository,
        deployment_id: latest.id,
        per_page: 1,
        headers: { 'X-GitHub-Api-Version': '2022-11-28' },
      },
    );
    status = (result.data as any[])[0];
  }
  const repositorySha = (commit.data as any).sha as string;
  const deploymentSha = latest?.sha as string | undefined;
  const deploymentState = status?.state as string | undefined;
  const phase = targetSha
    ? resolveStudioDeploymentPhase({
        targetSha,
        runtimeSha,
        repositorySha,
        deploymentSha,
        deploymentState,
      })
    : 'submitted';
  return {
    phase,
    targetSha,
    runtimeSha,
    repositorySha,
    deploymentSha,
    state: status?.state ?? (latest ? 'pending' : 'unknown'),
    environment: latest?.environment ?? 'Production',
    updatedAt: status?.updated_at ?? latest?.updated_at,
    logUrl: status?.log_url ?? latest?.statuses_url,
  };
}

export async function listStudioAssets(token?: string): Promise<StudioAsset[]> {
  const base = 'src/assets/images/content';
  if (!token) {
    const root = resolve(process.cwd(), base);
    const walk = async (directory: string): Promise<StudioAsset[]> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return [];
      }
      return (
        await Promise.all(
          entries.map(async (entry) => {
            const path = resolve(directory, entry.name);
            if (entry.isDirectory()) return walk(path);
            const relative = `${base}/${path.slice(root.length + 1).replaceAll('\\', '/')}`;
            return [{ name: entry.name, path: relative, size: 0, url: `/@fs/${path}` }];
          }),
        )
      ).flat();
    };
    return walk(root);
  }

  const response = await github(token).request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
    ...repository,
    tree_sha: repository.branch,
    recursive: '1',
    headers: { 'X-GitHub-Api-Version': '2022-11-28' },
  });
  return ((response.data as any).tree as any[])
    .filter((entry) => entry.type === 'blob' && entry.path.startsWith(`${base}/`))
    .map((entry) => ({
      name: entry.path.split('/').at(-1),
      path: entry.path,
      sha: entry.sha,
      size: entry.size ?? 0,
      url: `https://raw.githubusercontent.com/${repository.owner}/${repository.repo}/${repository.branch}/${entry.path}`,
    }));
}
