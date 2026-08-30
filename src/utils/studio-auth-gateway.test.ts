import { describe, expect, test } from 'bun:test';
import {
  createStudioAuthService,
  createStudioSessionToken,
  normalizeStudioNextPath,
  STUDIO_SESSION_COOKIE,
  verifyStudioCredentials,
  verifyStudioSessionToken,
} from './studio-auth-gateway';
import { STUDIO_GITHUB_OAUTH_COOKIE, type StudioGithubOAuthConfig } from './studio-github-oauth';

const password = 'a-strong-password-kept-outside-the-repository';
const sessionSecret = 'a-different-session-signing-secret-with-enough-entropy';

function request(path: string, init: RequestInit = {}) {
  return new Request(`https://studio.goumin.work${path}`, {
    ...init,
    headers: { Host: 'studio.goumin.work', ...init.headers },
  });
}

function createService(now = 1_800_000_000_000, github?: StudioGithubOAuthConfig) {
  return createStudioAuthService({
    github,
    now: () => now,
    password,
    passwordLogin: 'public',
    randomBytes: (length) => new Uint8Array(length).fill(7),
    sessionSecret,
    username: 'goumin',
  });
}

function githubConfig(userId = 66_173_922) {
  const requests: Array<{ method: string; url: string }> = [];
  const config: StudioGithubOAuthConfig = {
    allowedUserId: 66_173_922,
    callbackUrl: 'https://studio.goumin.work/api/studio/auth/github/callback',
    clientId: 'Iv1.studio-test-client',
    clientSecret: 'studio-test-client-secret-with-enough-length',
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ method: init?.method ?? 'GET', url });
      if (url.endsWith('/login/oauth/access_token')) {
        return Response.json({ access_token: 'ghu_one-use-studio-token' });
      }
      if (url.endsWith('/user')) return Response.json({ id: userId, login: 'GM2020JLU' });
      if (url.includes('/applications/') && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    },
  };
  return { config, requests };
}

describe('Studio 会话签名', () => {
  test('接受有效会话并拒绝篡改或过期的会话', async () => {
    const now = 1_800_000_000_000;
    const token = await createStudioSessionToken({
      nonce: new Uint8Array(18).fill(4),
      now,
      secret: sessionSecret,
      ttlSeconds: 60,
    });

    expect(await verifyStudioSessionToken({ now, secret: sessionSecret, token })).toBe(true);
    expect(
      await verifyStudioSessionToken({
        now,
        secret: sessionSecret,
        token: `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`,
      }),
    ).toBe(false);
    expect(
      await verifyStudioSessionToken({ now: now + 61_000, secret: sessionSecret, token }),
    ).toBe(false);
    expect(
      await verifyStudioSessionToken({ now, secret: sessionSecret, token: 'x'.repeat(513) }),
    ).toBe(false);
    expect(
      await verifyStudioSessionToken({
        allowedSubjects: new Set(['github:66173922']),
        now,
        secret: sessionSecret,
        token,
      }),
    ).toBe(false);
    expect(
      await verifyStudioSessionToken({
        allowedSubjects: new Set(['test']),
        now,
        secret: sessionSecret,
        token,
      }),
    ).toBe(true);
    expect(
      await verifyStudioSessionToken({
        now,
        secret: sessionSecret,
        token: 'v1.1800000060.invalid.invalid',
      }),
    ).toBe(false);
  });

  test('账号和密码同时匹配才通过', async () => {
    expect(
      await verifyStudioCredentials({
        expectedPassword: password,
        expectedUsername: 'goumin',
        password,
        username: 'goumin',
      }),
    ).toBe(true);
    expect(
      await verifyStudioCredentials({
        expectedPassword: password,
        expectedUsername: 'goumin',
        password: `${password}!`,
        username: 'goumin',
      }),
    ).toBe(false);
  });
});

describe('Studio 登录跳转', () => {
  test('拒绝未配置或格式异常的 Host', async () => {
    const service = createService();
    const foreignHost = await service(
      new Request('https://attacker.example/studio/login', {
        headers: { Host: 'attacker.example' },
      }),
    );
    expect(foreignHost.status).toBe(421);
    const invalidHost = await service(
      new Request('https://studio.goumin.work/studio/login', {
        headers: { Host: 'studio.goumin.work:invalid' },
      }),
    );
    expect(invalidHost.status).toBe(421);
  });

  test('只允许后台与预览站内路径', () => {
    expect(normalizeStudioNextPath('/studio/edit/blog/demo?new=1')).toBe(
      '/studio/edit/blog/demo?new=1',
    );
    expect(normalizeStudioNextPath('/preview/blog/demo')).toBe('/preview/blog/demo');
    expect(normalizeStudioNextPath('//attacker.example/studio')).toBe('/studio');
    expect(normalizeStudioNextPath('https://attacker.example/studio')).toBe('/studio');
    expect(normalizeStudioNextPath('/api/studio/assets')).toBe('/studio');
  });

  test('未登录页面请求被送往自绘登录页，API 返回 JSON 401', async () => {
    const service = createService();
    const page = await service(
      request('/internal/studio-auth/verify', {
        headers: {
          Accept: 'text/html',
          'Sec-Fetch-Dest': 'document',
          'X-Forwarded-Method': 'GET',
          'X-Forwarded-Uri': '/studio/edit/blog/demo?draft=1',
        },
      }),
    );
    expect(page.status).toBe(303);
    expect(page.headers.get('location')).toBe(
      '/studio/login?next=%2Fstudio%2Fedit%2Fblog%2Fdemo%3Fdraft%3D1',
    );

    const api = await service(
      request('/internal/studio-auth/verify', {
        headers: {
          Accept: 'application/json',
          'X-Forwarded-Method': 'PUT',
          'X-Forwarded-Uri': '/api/studio/site',
        },
      }),
    );
    expect(api.status).toBe(401);
    expect(await api.json()).toMatchObject({ loginUrl: '/studio/login' });
  });

  test('登录页自包含、可切换主题且不会回显密码', async () => {
    const service = createService();
    const response = await service(request('/studio/login?error=credentials&next=/studio'));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin');
    expect(html).toContain('回来继续创作。');
    expect(html).toContain('账号或密码不正确，请重试。');
    expect(html).toContain('data-theme-toggle');
    expect(html).toContain('autocomplete="current-password"');
    expect(html).not.toContain(password);
  });

  test('GitHub 是主登录入口，密码作为可展开的备用方式', async () => {
    const { config } = githubConfig();
    const service = createService(1_800_000_000_000, config);
    const response = await service(request('/studio/login?next=/studio/edit/blog/demo'));
    const html = await response.text();

    expect(html).toContain('使用 GitHub 继续');
    expect(html).toContain('class="password-fallback"');
    expect(html).toContain('/api/studio/auth/github/start?next=%2Fstudio%2Fedit%2Fblog%2Fdemo');
    expect(html).not.toContain('class="password-fallback" open');
  });

  test('公网只展示 GitHub 并拒绝密码提交，密码仅在回环地址恢复', async () => {
    const { config } = githubConfig();
    const service = createStudioAuthService({
      github: config,
      now: () => 1_800_000_000_000,
      password,
      passwordLogin: 'loopback',
      randomBytes: (length) => new Uint8Array(length).fill(7),
      sessionSecret,
      username: 'goumin',
    });

    const publicPage = await service(request('/studio/login'));
    const publicHtml = await publicPage.text();
    expect(publicHtml).toContain('使用 GitHub 继续');
    expect(publicHtml).not.toContain(`<form method="post" action="/api/studio/session"`);
    const publicPassword = await service(
      request('/api/studio/session', {
        body: new URLSearchParams({ password, username: 'goumin' }),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'https://studio.goumin.work',
        },
        method: 'POST',
      }),
    );
    expect(publicPassword.status).toBe(404);
    const passwordToken = await createStudioSessionToken({
      nonce: new Uint8Array(18).fill(2),
      now: 1_800_000_000_000,
      secret: sessionSecret,
      subject: 'password:local',
    });
    const publicVerification = await service(
      request('/internal/studio-auth/verify', {
        headers: {
          Cookie: `${STUDIO_SESSION_COOKIE}=${passwordToken}`,
          'X-Forwarded-Method': 'GET',
          'X-Forwarded-Uri': '/studio',
        },
      }),
    );
    expect(publicVerification.status).toBe(401);

    const localPage = await service(
      new Request('http://127.0.0.1:4322/studio/login', {
        headers: { Host: '127.0.0.1:4322' },
      }),
    );
    const localHtml = await localPage.text();
    expect(localHtml).toContain(`<form method="post" action="/api/studio/session"`);
    expect(localHtml).not.toContain('使用 GitHub 继续');
  });

  test('正确凭据签发安全 Cookie，随后通过 Caddy 前置校验', async () => {
    const service = createService();
    const login = await service(
      request('/api/studio/session', {
        body: new URLSearchParams({
          next: '/studio/edit/blog/demo',
          password,
          username: 'goumin',
        }),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'https://studio.goumin.work',
        },
        method: 'POST',
      }),
    );

    expect(login.status).toBe(303);
    expect(login.headers.get('location')).toBe('/studio/edit/blog/demo');
    const setCookie = login.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${STUDIO_SESSION_COOKIE}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');

    const sessionValue = setCookie.match(new RegExp(`${STUDIO_SESSION_COOKIE}=([^;,]+)`))?.[1];
    expect(sessionValue).toBeTruthy();
    const cookie = `${STUDIO_SESSION_COOKIE}=${sessionValue}`;
    const verification = await service(
      request('/internal/studio-auth/verify', {
        headers: {
          Cookie: cookie,
          'X-Forwarded-Method': 'GET',
          'X-Forwarded-Uri': '/studio',
        },
      }),
    );
    expect(verification.status).toBe(204);
  });

  test('GitHub OAuth 使用 state、PKCE 和数字用户 ID 签发会话，且拒绝重放', async () => {
    const now = 1_800_000_000_000;
    const { config, requests } = githubConfig();
    const service = createService(now, config);
    const start = await service(
      request('/api/studio/auth/github/start?next=/studio/edit/blog/demo'),
    );
    const authorize = new URL(start.headers.get('location')!);
    const transactionCookie = (start.headers.get('set-cookie') ?? '').split(';')[0]!;

    expect(start.status).toBe(303);
    expect(authorize.origin).toBe('https://github.com');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(transactionCookie).toStartWith(`${STUDIO_GITHUB_OAUTH_COOKIE}=`);
    expect(start.headers.get('set-cookie')).toContain('SameSite=Lax');

    const callbackPath = `/api/studio/auth/github/callback?code=one-time-code&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`;
    const callback = await service(
      request(callbackPath, { headers: { Cookie: transactionCookie } }),
    );
    const setCookie = callback.headers.get('set-cookie') ?? '';

    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe('/studio/edit/blog/demo');
    expect(setCookie).toContain(`${STUDIO_SESSION_COOKIE}=`);
    expect(setCookie).toContain(`${STUDIO_GITHUB_OAUTH_COOKIE}=;`);
    expect(requests.map((entry) => entry.method)).toEqual(['POST', 'GET', 'DELETE']);

    const replay = await service(request(callbackPath, { headers: { Cookie: transactionCookie } }));
    expect(replay.headers.get('location')).toContain('error=github');
    expect(requests).toHaveLength(3);
  });

  test('GitHub 回调拒绝未授权账号与不匹配的 state', async () => {
    const { config } = githubConfig(123_456);
    const service = createService(1_800_000_000_000, config);
    const start = await service(request('/api/studio/auth/github/start?next=/studio'));
    const authorize = new URL(start.headers.get('location')!);
    const transactionCookie = (start.headers.get('set-cookie') ?? '').split(';')[0]!;
    const state = authorize.searchParams.get('state')!;

    const mismatched = await service(
      request('/api/studio/auth/github/callback?code=x&state=wrong', {
        headers: { Cookie: transactionCookie },
      }),
    );
    expect(mismatched.headers.get('location')).toBe('/studio/login?error=github&next=%2Fstudio');

    const unauthorized = await service(
      request(`/api/studio/auth/github/callback?code=x&state=${encodeURIComponent(state)}`, {
        headers: { Cookie: transactionCookie },
      }),
    );
    expect(unauthorized.headers.get('location')).toBe('/studio/login?error=account&next=%2Fstudio');
    expect(unauthorized.headers.get('set-cookie')).not.toContain(`${STUDIO_SESSION_COOKIE}=`);
  });

  test('GitHub OAuth 入口按客户端地址限速', async () => {
    const { config } = githubConfig();
    const service = createService(1_800_000_000_000, config);
    for (let attempt = 0; attempt < 30; attempt++) {
      const response = await service(
        request('/api/studio/auth/github/start', {
          headers: { 'CF-Connecting-IP': '203.0.113.20' },
        }),
      );
      expect(response.headers.get('location')).toStartWith(
        'https://github.com/login/oauth/authorize',
      );
    }
    const limited = await service(
      request('/api/studio/auth/github/start', {
        headers: { 'CF-Connecting-IP': '203.0.113.20' },
      }),
    );
    expect(limited.headers.get('location')).toBe('/studio/login?error=rate&next=%2Fstudio');
    expect(limited.headers.get('retry-after')).toBe('900');
  });

  test('拒绝跨站登录，并在连续失败后限速', async () => {
    const service = createService();
    const body = new URLSearchParams({ password: 'wrong', username: 'goumin' });
    const crossSite = await service(
      request('/api/studio/session', {
        body,
        headers: { Origin: 'https://attacker.example' },
        method: 'POST',
      }),
    );
    expect(crossSite.status).toBe(403);
    const wrongPort = await service(
      request('/api/studio/session', {
        body: new URLSearchParams({ password, username: 'goumin' }),
        headers: { Origin: 'https://studio.goumin.work:444' },
        method: 'POST',
      }),
    );
    expect(wrongPort.status).toBe(403);
    const missingOrigin = await service(
      request('/api/studio/session', {
        body: new URLSearchParams({ password, username: 'goumin' }),
        method: 'POST',
      }),
    );
    expect(missingOrigin.status).toBe(403);
    const opaqueOrigin = await service(
      request('/api/studio/session', {
        body: new URLSearchParams({ password, username: 'goumin' }),
        headers: { Origin: 'null' },
        method: 'POST',
      }),
    );
    expect(opaqueOrigin.status).toBe(403);

    for (let attempt = 0; attempt < 5; attempt++) {
      const failed = await service(
        request('/api/studio/session', {
          body: new URLSearchParams({ password: 'wrong', username: 'goumin' }),
          headers: {
            'CF-Connecting-IP': '203.0.113.9',
            Origin: 'https://studio.goumin.work',
            'User-Agent': `rotating-agent-${attempt}`,
          },
          method: 'POST',
        }),
      );
      expect(failed.headers.get('location')).toContain('error=credentials');
    }
    const limited = await service(
      request('/api/studio/session', {
        body: new URLSearchParams({ password, username: 'goumin' }),
        headers: {
          'CF-Connecting-IP': '203.0.113.9',
          Origin: 'https://studio.goumin.work',
          'User-Agent': 'one-more-agent',
        },
        method: 'POST',
      }),
    );
    expect(limited.status).toBe(303);
    expect(limited.headers.get('location')).toBe('/studio/login?error=rate');
    expect(limited.headers.get('retry-after')).toBe('900');
    const ratePage = await service(request('/studio/login?error=rate'));
    expect(ratePage.status).toBe(429);
    expect(ratePage.headers.get('retry-after')).toBe('900');
  });

  test('拒绝错误表单类型和没有可信 Content-Length 的超大请求体', async () => {
    const service = createService();
    const unsupported = await service(
      request('/api/studio/session', {
        body: JSON.stringify({ password, username: 'goumin' }),
        headers: { 'Content-Type': 'application/json', Origin: 'https://studio.goumin.work' },
        method: 'POST',
      }),
    );
    expect(unsupported.status).toBe(415);

    const oversized = await service(
      request('/api/studio/session', {
        body: `username=goumin&password=${'x'.repeat(9_000)}`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'https://studio.goumin.work',
        },
        method: 'POST',
      }),
    );
    expect(oversized.status).toBe(413);
  });

  test('已登录的写请求仍需通过同源校验，退出会清除 Cookie', async () => {
    const now = 1_800_000_000_000;
    const service = createService(now);
    const token = await createStudioSessionToken({
      nonce: new Uint8Array(18).fill(2),
      now,
      secret: sessionSecret,
      subject: 'password:local',
    });
    const cookie = `${STUDIO_SESSION_COOKIE}=${token}`;

    const crossSiteWrite = await service(
      request('/internal/studio-auth/verify', {
        headers: {
          Cookie: cookie,
          Origin: 'https://attacker.example',
          'X-Forwarded-Method': 'DELETE',
          'X-Forwarded-Uri': '/api/studio/content/blog/demo',
        },
      }),
    );
    expect(crossSiteWrite.status).toBe(403);

    const logout = await service(
      request('/api/studio/session/logout', {
        headers: { Cookie: cookie, Origin: 'https://studio.goumin.work' },
        method: 'POST',
      }),
    );
    expect(logout.status).toBe(303);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(logout.headers.get('set-cookie')).toContain(`${STUDIO_GITHUB_OAUTH_COOKIE}=;`);
    expect(logout.headers.get('location')).toBe('/studio/login');
  });
});
