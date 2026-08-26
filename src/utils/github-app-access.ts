import { Octokit } from '@octokit/core';

const expectedAppSlug = 'gm2020jlu-keystatic';
const expectedRepository = 'GM2020JLU/GM-WEB';

type GitHubRequest = (
  route: string,
  parameters: Record<string, unknown>,
) => Promise<{ data?: unknown }>;

type Installation = {
  app_slug?: string;
  html_url?: string;
  id?: number;
  permissions?: { contents?: string };
};

type Repository = {
  full_name?: string;
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean };
};

export interface GitHubAccessDiagnosis {
  appContentsPermission: string;
  appInstalled: boolean;
  installationSettingsUrl: string;
  login: string;
  repositoryPush: boolean;
  repositorySelected: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export async function diagnoseGitHubMarkdownAccess(
  args: { token: string },
  request?: GitHubRequest,
): Promise<GitHubAccessDiagnosis> {
  const githubRequest =
    request ?? new Octokit({ auth: args.token, userAgent: 'goumin-work-access-check' }).request;
  const headers = { 'X-GitHub-Api-Version': '2022-11-28' };
  const userResult = await githubRequest('GET /user', { headers });
  const login =
    typeof record(userResult.data).login === 'string' ? String(record(userResult.data).login) : '';
  const installationResult = await githubRequest('GET /user/installations', {
    headers,
    per_page: 100,
  });
  const installations = Array.isArray(record(installationResult.data).installations)
    ? (record(installationResult.data).installations as Installation[])
    : [];
  const installation = installations.find((item) => item.app_slug === expectedAppSlug);
  if (!installation?.id) {
    return {
      appContentsPermission: '',
      appInstalled: false,
      installationSettingsUrl: '',
      login,
      repositoryPush: false,
      repositorySelected: false,
    };
  }

  const repositoryResult = await githubRequest(
    'GET /user/installations/{installation_id}/repositories',
    { headers, installation_id: installation.id, per_page: 100 },
  );
  const repositories = Array.isArray(record(repositoryResult.data).repositories)
    ? (record(repositoryResult.data).repositories as Repository[])
    : [];
  const repository = repositories.find(
    (item) =>
      item.full_name?.toLocaleLowerCase('en-US') === expectedRepository.toLocaleLowerCase('en-US'),
  );

  return {
    appContentsPermission: installation.permissions?.contents || '',
    appInstalled: true,
    installationSettingsUrl: installation.html_url || '',
    login,
    repositoryPush: Boolean(
      repository?.permissions?.push ||
      repository?.permissions?.maintain ||
      repository?.permissions?.admin,
    ),
    repositorySelected: Boolean(repository),
  };
}

export function githubAccessErrorMessage(diagnosis: GitHubAccessDiagnosis) {
  const account = diagnosis.login ? `当前 OAuth 登录账号是 ${diagnosis.login}。` : '';
  if (!diagnosis.appInstalled) {
    return `${account} 该账号的授权令牌看不到 gm2020jlu-keystatic 安装实例，请退出后台并确认使用 GM2020JLU 重新登录。`;
  }
  if (diagnosis.appContentsPermission !== 'write') {
    return `${account} GitHub App 安装实例尚未批准 Contents 写权限，请在安装设置中确认新的权限。`;
  }
  if (!diagnosis.repositorySelected) {
    return `${account} GitHub App 安装实例没有向此令牌开放 GM2020JLU/GM-WEB，请在仓库选择中加入该仓库。`;
  }
  if (!diagnosis.repositoryPush) {
    return `${account} 当前账号能看到 GM-WEB，但 GitHub 返回的仓库权限不包含 push。`;
  }
  return `${account} App、仓库和 push 权限均已识别，但当前令牌仍被 GitHub 拒绝；请退出 Keystatic 后重新授权以刷新令牌。`;
}
