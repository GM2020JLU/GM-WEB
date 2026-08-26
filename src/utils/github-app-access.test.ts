import { describe, expect, test } from 'bun:test';
import { diagnoseGitHubMarkdownAccess, githubAccessErrorMessage } from './github-app-access';

describe('GitHub App 导入权限诊断', () => {
  test('识别 OAuth 账号、安装实例、目标仓库和 push 权限', async () => {
    const request = async (route: string) => {
      if (route === 'GET /user') return { data: { login: 'GM2020JLU' } };
      if (route === 'GET /user/installations') {
        return {
          data: {
            installations: [
              {
                id: 42,
                app_slug: 'gm2020jlu-keystatic',
                html_url: 'https://github.com/settings/installations/42',
                permissions: { contents: 'write' },
              },
            ],
          },
        };
      }
      return {
        data: {
          repositories: [
            { full_name: 'GM2020JLU/GM-WEB', permissions: { push: true, admin: true } },
          ],
        },
      };
    };

    const diagnosis = await diagnoseGitHubMarkdownAccess({ token: 'test' }, request);
    expect(diagnosis).toEqual({
      appContentsPermission: 'write',
      appInstalled: true,
      installationSettingsUrl: 'https://github.com/settings/installations/42',
      login: 'GM2020JLU',
      repositoryPush: true,
      repositorySelected: true,
    });
    expect(githubAccessErrorMessage(diagnosis)).toContain('权限均已识别');
  });

  test('明确指出 OAuth 登录账号看不到 App 安装', async () => {
    const request = async (route: string) =>
      route === 'GET /user' ? { data: { login: 'another-user' } } : { data: { installations: [] } };
    const diagnosis = await diagnoseGitHubMarkdownAccess({ token: 'test' }, request);
    expect(githubAccessErrorMessage(diagnosis)).toContain('another-user');
    expect(githubAccessErrorMessage(diagnosis)).toContain('看不到');
  });

  test('明确指出安装实例未包含目标仓库', () => {
    expect(
      githubAccessErrorMessage({
        appContentsPermission: 'write',
        appInstalled: true,
        installationSettingsUrl: '',
        login: 'GM2020JLU',
        repositoryPush: false,
        repositorySelected: false,
      }),
    ).toContain('没有向此令牌开放');
  });
});
