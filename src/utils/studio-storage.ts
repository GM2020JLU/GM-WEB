import { Octokit } from '@octokit/core';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  createStudioBackupRecord,
  parseStudioBackupRecord,
  type StudioBackupRecord,
} from './studio-backup-record';
import {
  commitStudioLocalDeploymentIntent,
  prepareStudioLocalDeploymentIntent,
} from './studio-local-deployment';
import { resolveStudioDeploymentPhase } from './studio-deployment';
import { withStudioContentFileLock } from './studio-runtime-lock';

const repository = { owner: 'GM2020JLU', repo: 'GM-WEB', branch: 'main' } as const;

type GitHubContent = {
  content?: string;
  encoding?: string;
  name?: string;
  sha?: string;
  type?: string;
};

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
  readonly status = 409;

  constructor(message = '内容已被其他操作修改，请刷新后重试。') {
    super(message);
    this.name = 'StudioConflictError';
  }
}

function localContentSha(content: string | Buffer) {
  return createHash('sha256').update(content).digest('hex');
}

let localWriteTail: Promise<void> = Promise.resolve();

function withLocalWriteLock<T>(operation: () => Promise<T>) {
  const lockedOperation = () => withStudioContentFileLock(operation);
  const result = localWriteTail.then(lockedOperation, lockedOperation);
  localWriteTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

type LocalDeploymentIntentOptions = { deploy: boolean; reason: string };

async function withLocalDeploymentIntent<T extends object>(
  deployment: LocalDeploymentIntentOptions | undefined,
  operation: () => Promise<T>,
) {
  const intentId = deployment?.deploy
    ? await prepareStudioLocalDeploymentIntent(deployment.reason)
    : undefined;
  try {
    const result = await operation();
    if (intentId) await commitStudioLocalDeploymentIntent(intentId);
    return { ...result, localDeploymentId: intentId };
  } catch (error) {
    // Once an intent exists we cannot prove an interrupted multi-step write made
    // no durable filesystem change. Keep the prepared intent for conservative
    // replay; an extra no-op deployment is safer than losing a publication.
    throw error;
  }
}

type LocalBackup = StudioBackupRecord;

function localBackupRoot() {
  return resolve(process.cwd(), process.env.STUDIO_RUNTIME_DIR || '.studio/runtime', 'backups');
}

function localOffsitePendingRoot() {
  return resolve(
    process.cwd(),
    process.env.STUDIO_RUNTIME_DIR || '.studio/runtime',
    'offsite-pending',
  );
}

async function createLocalOffsiteSnapshot(
  path: string,
  content: string,
  message: string,
  encoding: LocalBackup['encoding'] = 'utf8',
) {
  const date = new Date().toISOString();
  const record = createStudioBackupRecord({
    content,
    date,
    encoding,
    kind: 'snapshot',
    message,
    path,
  });
  const { sha } = record;
  const root = localOffsitePendingRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const target = resolve(root, `${sha}.json`);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await rename(temporary, target);
}

async function createLocalOffsiteTombstone(path: string, message: string, afterDate?: string) {
  const after = afterDate ? Date.parse(afterDate) : Number.NaN;
  const date = new Date(Math.max(Date.now(), Number.isFinite(after) ? after + 1 : 0)).toISOString();
  const record = createStudioBackupRecord({
    content: '',
    date,
    deleted: true,
    encoding: 'utf8',
    kind: 'tombstone',
    message,
    path,
  });
  const { sha } = record;
  const root = localOffsitePendingRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const target = resolve(root, `${sha}.json`);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await rename(temporary, target);
}

async function createLocalBackup(
  path: string,
  content: string,
  message: string,
  encoding: LocalBackup['encoding'] = 'utf8',
) {
  const date = new Date().toISOString();
  const record = createStudioBackupRecord({
    content,
    date,
    encoding,
    kind: 'history',
    message,
    path,
  });
  const { sha } = record;
  const root = localBackupRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const target = resolve(root, `${sha}.json`);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await rename(temporary, target);
  await pruneLocalBackups(path);
  return { date, sha };
}

async function pruneLocalBackups(path: string, now = Date.now()) {
  const root = localBackupRoot();
  let files: string[];
  try {
    files = await readdir(root);
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  const matching = (
    await Promise.all(
      files
        .filter((file) => file.endsWith('.json'))
        .map(async (file) => {
          try {
            const backup = parseStudioBackupRecord(await readFile(resolve(root, file)), file);
            return backup.path === path ? { backup, file } : undefined;
          } catch {
            return undefined;
          }
        }),
    )
  )
    .filter((entry): entry is { backup: LocalBackup; file: string } => Boolean(entry))
    .sort((a, b) => b.backup.date.localeCompare(a.backup.date));
  const maximumAge = 120 * 24 * 60 * 60 * 1000;
  await Promise.all(
    matching
      .filter((entry, index) => index >= 30 || now - Date.parse(entry.backup.date) > maximumAge)
      .map((entry) => rm(resolve(root, entry.file), { force: true })),
  );
}

async function atomicWriteLocalFile(target: string, content: string | Buffer) {
  await mkdir(dirname(target), { recursive: true });
  const temporary = resolve(
    dirname(target),
    `.${target.split('/').at(-1)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await writeFile(temporary, content, { mode: 0o644, flag: 'wx' });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readLocalBackups(path: string) {
  let files: string[];
  try {
    files = await readdir(localBackupRoot());
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const backups: LocalBackup[] = [];
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    try {
      const backup = parseStudioBackupRecord(
        await readFile(resolve(localBackupRoot(), file)),
        file,
      );
      if (
        backup.path === path &&
        !backup.deleted &&
        (backup.kind === undefined || backup.kind === 'history') &&
        backup.content !== undefined &&
        backup.sha &&
        (backup.encoding === undefined || backup.encoding === 'utf8')
      ) {
        backups.push({ ...backup, encoding: 'utf8' });
      }
    } catch {
      // An incomplete backup must not hide the remaining usable history.
    }
  }
  return backups.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);
}

async function readLocalBackup(path: string, ref: string) {
  if (!/^[a-f0-9]{7,40}$/i.test(ref)) throw new StudioConflictError('历史版本标识不合法。');
  const backup = (await readLocalBackups(path)).find(
    (entry) => entry.sha === ref || entry.sha.startsWith(ref),
  );
  if (!backup) throw new StudioConflictError('找不到这个本地备份版本。');
  return backup.content;
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
  if (!token) {
    const content = await readFile(resolve(process.cwd(), path), 'utf8');
    return { path, content, sha: localContentSha(content) };
  }
  const response = await github(token).request('GET /repos/{owner}/{repo}/contents/{path}', {
    ...repository,
    path,
    ref: repository.branch,
    headers: { 'X-GitHub-Api-Version': '2022-11-28' },
  });
  const data = response.data as GitHubContent;
  return { path, content: decodeContent(data), sha: data.sha };
}

export async function studioFileExists(path: string, token?: string) {
  if (!token) {
    try {
      return (await stat(resolve(process.cwd(), path))).isFile();
    } catch (error) {
      if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }
  try {
    const response = await github(token).request('GET /repos/{owner}/{repo}/contents/{path}', {
      ...repository,
      path,
      ref: repository.branch,
      headers: { 'X-GitHub-Api-Version': '2022-11-28' },
    });
    return !Array.isArray(response.data) && (response.data as GitHubContent).type === 'file';
  } catch (error) {
    if (typeof error === 'object' && error && 'status' in error && error.status === 404)
      return false;
    throw error;
  }
}

export async function getStudioTaxonomies(token?: string) {
  const collections = ['categories', 'series', 'tags'] as const;
  const values = await Promise.all(
    collections.map(async (collection) => {
      const path = `src/content/taxonomies/${collection}`;
      if (!token) {
        const files = await readdir(resolve(process.cwd(), path));
        return new Set(
          files.filter((file) => file.endsWith('.yaml')).map((file) => file.slice(0, -5)),
        );
      }
      const response = await github(token).request('GET /repos/{owner}/{repo}/contents/{path}', {
        ...repository,
        path,
        ref: repository.branch,
        headers: { 'X-GitHub-Api-Version': '2022-11-28' },
      });
      return new Set(
        (response.data as GitHubContent[])
          .filter((entry) => entry.type === 'file' && entry.name?.endsWith('.yaml'))
          .map((entry) => entry.name!.slice(0, -5)),
      );
    }),
  );
  return Object.fromEntries(
    collections.map((collection, index) => [collection, values[index]]),
  ) as Record<(typeof collections)[number], Set<string>>;
}

export async function writeStudioFile(args: {
  beforeWrite?: () => Promise<void>;
  content: string;
  deployment?: LocalDeploymentIntentOptions;
  expectedSha?: string | null;
  message: string;
  path: string;
  previousPath?: string;
  repositoryRoot?: string;
  token?: string;
}) {
  if (!args.token) {
    return withLocalWriteLock(() =>
      withLocalDeploymentIntent(args.deployment, async () => {
        const repositoryRoot = args.repositoryRoot || process.cwd();
        const target = resolve(repositoryRoot, args.path);
        const isMove = Boolean(args.previousPath && args.previousPath !== args.path);
        const versionPath = isMove ? args.previousPath! : args.path;
        const versionTarget = resolve(repositoryRoot, versionPath);
        let previous: string | undefined;
        try {
          previous = await readFile(versionTarget, 'utf8');
        } catch (error) {
          if (!(typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT')) {
            throw error;
          }
        }

        if (args.expectedSha === null) {
          if (previous !== undefined) throw new StudioConflictError('同名内容已经存在。');
        } else if (args.expectedSha !== undefined) {
          if (previous === undefined || localContentSha(previous) !== args.expectedSha) {
            throw new StudioConflictError();
          }
        }

        if (isMove) {
          try {
            await readFile(target, 'utf8');
            throw new StudioConflictError('新的内容标识已经存在。');
          } catch (error) {
            if (
              error instanceof StudioConflictError ||
              !(typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT')
            ) {
              throw error;
            }
          }
        }

        await args.beforeWrite?.();
        const backup =
          previous !== undefined
            ? await createLocalBackup(versionPath, previous, args.message)
            : undefined;
        await atomicWriteLocalFile(target, args.content);
        if (isMove) {
          await unlink(versionTarget);
          await createLocalOffsiteTombstone(
            versionPath,
            `Move ${versionPath} to ${args.path}`,
            backup?.date,
          );
        }
        await createLocalOffsiteSnapshot(args.path, args.content, args.message);
        return {
          path: args.path,
          commitSha: undefined,
          contentSha: localContentSha(args.content),
        };
      }),
    );
  }

  const client = github(args.token);
  try {
    await args.beforeWrite?.();
    const response = await client.request('PUT /repos/{owner}/{repo}/contents/{path}', {
      ...repository,
      path: args.path,
      branch: repository.branch,
      message: args.message,
      content: Buffer.from(args.content, 'utf8').toString('base64'),
      ...(!args.previousPath && args.expectedSha ? { sha: args.expectedSha } : {}),
      headers: { 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (args.previousPath && args.previousPath !== args.path) {
      if (!args.expectedSha) throw new StudioConflictError('缺少内容版本，请刷新后再重命名。');
      await client.request('DELETE /repos/{owner}/{repo}/contents/{path}', {
        ...repository,
        path: args.previousPath,
        branch: repository.branch,
        message: `Move content to ${args.path}`,
        sha: args.expectedSha,
        headers: { 'X-GitHub-Api-Version': '2022-11-28' },
      });
    }
    const data = response.data as { commit?: { sha?: string }; content?: { sha?: string } };
    return {
      path: args.path,
      commitSha: data.commit?.sha,
      contentSha: data.content?.sha,
      localDeploymentId: undefined,
    };
  } catch (error) {
    if (
      typeof error === 'object' &&
      error &&
      'status' in error &&
      (error.status === 409 || error.status === 422)
    ) {
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
    return withLocalWriteLock(async () => {
      const target = resolve(process.cwd(), args.path);
      await mkdir(dirname(target), { recursive: true });
      try {
        await writeFile(target, args.content, { flag: 'wx', mode: 0o644 });
      } catch (error) {
        if (typeof error === 'object' && error && 'code' in error && error.code === 'EEXIST') {
          throw new StudioConflictError('同名素材已经存在。');
        }
        throw error;
      }
      await createLocalOffsiteSnapshot(
        args.path,
        args.content.toString('base64'),
        args.message,
        'base64',
      );
      return { path: args.path, contentSha: localContentSha(args.content) };
    });
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

export interface StudioDeleteFileOptions {
  beforeDelete?: () => Promise<void>;
  deployment?: LocalDeploymentIntentOptions;
}

export async function deleteStudioFile(
  path: string,
  sha: string | undefined,
  token?: string,
  options: StudioDeleteFileOptions = {},
) {
  if (!token) {
    return withLocalWriteLock(() =>
      withLocalDeploymentIntent(options.deployment, async () => {
        const target = resolve(process.cwd(), path);
        const previous = await readFile(target);
        if (!sha) throw new StudioConflictError('缺少内容版本，请刷新后再删除。');
        if (localContentSha(previous) !== sha) throw new StudioConflictError();
        await options.beforeDelete?.();
        const binaryAsset = path.replaceAll('\\', '/').match(/(?:^|\/)src\/assets\//);
        const backup = binaryAsset
          ? await createLocalBackup(path, previous.toString('base64'), `Delete ${path}`, 'base64')
          : await createLocalBackup(path, previous.toString('utf8'), `Delete ${path}`);
        await unlink(target);
        await createLocalOffsiteTombstone(path, `Delete ${path}`, backup.date);
        return { commitSha: undefined };
      }),
    );
  }
  if (!sha) throw new StudioConflictError('缺少内容版本，请刷新后再删除。');
  await options.beforeDelete?.();
  const response = await github(token).request('DELETE /repos/{owner}/{repo}/contents/{path}', {
    ...repository,
    path,
    branch: repository.branch,
    message: `Delete content: ${path}`,
    sha,
    headers: { 'X-GitHub-Api-Version': '2022-11-28' },
  });
  return {
    commitSha: (response.data as { commit?: { sha?: string } }).commit?.sha,
    localDeploymentId: undefined,
  };
}

export async function listStudioHistory(
  path: string,
  token?: string,
): Promise<StudioHistoryEntry[]> {
  if (!token) {
    return (await readLocalBackups(path)).map((entry) => ({
      author: '本地后台',
      date: entry.date,
      message: entry.message,
      sha: entry.sha,
      url: '',
    }));
  }
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

export async function readStudioFileAtRef(path: string, ref: string, token?: string) {
  if (!token) return readLocalBackup(path, ref);
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
  const [commit, deployments, combinedStatus] = await Promise.all([
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
    targetSha
      ? client.request('GET /repos/{owner}/{repo}/commits/{ref}/status', {
          ...repository,
          ref: targetSha,
          headers: { 'X-GitHub-Api-Version': '2022-11-28' },
        })
      : Promise.resolve(undefined),
  ]);
  const allDeployments = deployments.data as any[];
  const latest = targetSha
    ? allDeployments.find((deployment) => deployment.sha === targetSha)
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
  const commitState = (combinedStatus?.data as any)?.state as string | undefined;
  const vercelStatus = ((combinedStatus?.data as any)?.statuses as any[] | undefined)?.find(
    (entry) => String(entry.context).toLowerCase() === 'vercel',
  );
  const phase = targetSha
    ? resolveStudioDeploymentPhase({
        targetSha,
        runtimeSha,
        repositorySha,
        deploymentSha,
        deploymentState,
        commitState,
      })
    : 'submitted';
  return {
    phase,
    targetSha,
    runtimeSha,
    repositorySha,
    deploymentSha,
    state: status?.state ?? commitState ?? (latest ? 'pending' : 'unknown'),
    environment: latest?.environment ?? 'Production',
    updatedAt: status?.updated_at ?? latest?.updated_at,
    logUrl: status?.log_url ?? vercelStatus?.target_url ?? latest?.statuses_url,
  };
}

export async function listStudioAssets(
  token?: string,
  localRepositoryRoot = process.cwd(),
): Promise<StudioAsset[]> {
  const base = 'src/assets/images/content';
  if (!token) {
    const root = resolve(localRepositoryRoot, base);
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
            const content = await readFile(path);
            return [
              {
                name: entry.name,
                path: relative,
                sha: localContentSha(content),
                size: content.byteLength,
                url: `/@fs/${path}`,
              },
            ];
          }),
        )
      ).flat();
    };
    return withLocalWriteLock(() => walk(root));
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

export const studioStorageInternals = { readLocalBackup, withLocalDeploymentIntent };
