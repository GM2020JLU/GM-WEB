import { describe, expect, test } from 'bun:test';
import {
  createStudioGithubOAuthTransaction,
  exchangeStudioGithubOAuthCode,
  verifyStudioGithubOAuthTransaction,
  type StudioGithubFetch,
  type StudioGithubOAuthConfig,
} from './studio-github-oauth';

const secret = 'a-dedicated-session-secret-with-enough-entropy';
const now = 1_800_000_000_000;
const callbackUrl = 'https://studio.goumin.work/api/studio/auth/github/callback';

function deterministicRandom() {
  let sequence = 0;
  return (length: number) => new Uint8Array(length).fill(++sequence);
}

describe('Studio GitHub OAuth transaction', () => {
  test('binds state, PKCE verifier and the safe return path in a signed transaction', async () => {
    const transaction = await createStudioGithubOAuthTransaction({
      callbackUrl,
      clientId: 'Iv1.test-client',
      nextPath: '/studio/edit/blog/demo',
      now,
      randomBytes: deterministicRandom(),
      secret,
    });
    const authorize = new URL(transaction.authorizeUrl);

    expect(authorize.origin + authorize.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(authorize.searchParams.get('state')).toBe(transaction.state);
    expect(authorize.searchParams.get('redirect_uri')).toBe(callbackUrl);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('code_challenge')).not.toBeNull();
    expect(authorize.searchParams.get('code_challenge')).not.toBe(transaction.state);

    const verified = await verifyStudioGithubOAuthTransaction({
      cookieValue: transaction.cookieValue,
      now,
      secret,
      state: transaction.state,
    });
    expect(verified?.nextPath).toBe('/studio/edit/blog/demo');
    expect(verified?.verifier).toHaveLength(43);
  });

  test('rejects missing, mismatched, expired and tampered transactions', async () => {
    const transaction = await createStudioGithubOAuthTransaction({
      callbackUrl,
      clientId: 'Iv1.test-client',
      nextPath: '/studio',
      now,
      randomBytes: deterministicRandom(),
      secret,
      ttlSeconds: 60,
    });

    expect(
      await verifyStudioGithubOAuthTransaction({
        cookieValue: transaction.cookieValue,
        now,
        secret,
        state: 'different-state',
      }),
    ).toBeNull();
    expect(
      await verifyStudioGithubOAuthTransaction({
        cookieValue: transaction.cookieValue,
        now: now + 61_000,
        secret,
        state: transaction.state,
      }),
    ).toBeNull();
    expect(
      await verifyStudioGithubOAuthTransaction({
        cookieValue: `${transaction.cookieValue.slice(0, -1)}x`,
        now,
        secret,
        state: transaction.state,
      }),
    ).toBeNull();
    expect(
      await verifyStudioGithubOAuthTransaction({
        cookieValue: undefined,
        now,
        secret,
        state: transaction.state,
      }),
    ).toBeNull();
  });
});

describe('Studio GitHub OAuth exchange', () => {
  test('uses PKCE, reads the immutable user id and revokes the temporary token', async () => {
    const requests: Array<{ method: string; url: string; body: string }> = [];
    const request: StudioGithubFetch = async (input, init) => {
      const url = String(input);
      requests.push({ method: init?.method ?? 'GET', url, body: String(init?.body ?? '') });
      if (url.endsWith('/login/oauth/access_token')) {
        return Response.json({ access_token: 'ghu_temporary-token' });
      }
      if (url.endsWith('/user')) {
        return Response.json({ id: 66_173_922, login: 'GM2020JLU' });
      }
      if (url.includes('/applications/') && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    };
    const config: StudioGithubOAuthConfig = {
      allowedUserId: 66_173_922,
      callbackUrl,
      clientId: 'Iv1.test-client',
      clientSecret: 'test-client-secret',
      fetch: request,
    };

    const identity = await exchangeStudioGithubOAuthCode({
      code: 'one-time-code',
      config,
      verifier: 'pkce-verifier',
    });

    expect(identity).toEqual({ id: 66_173_922, login: 'GM2020JLU' });
    expect(requests[0]?.body).toContain('code_verifier=pkce-verifier');
    expect(requests.map((entry) => entry.method)).toEqual(['POST', 'GET', 'DELETE']);
    expect(requests.at(-1)?.body).toContain('ghu_temporary-token');
  });

  test('fails closed when GitHub does not return a usable token', async () => {
    const config: StudioGithubOAuthConfig = {
      allowedUserId: 66_173_922,
      callbackUrl,
      clientId: 'Iv1.test-client',
      clientSecret: 'test-client-secret',
      fetch: async () => Response.json({ error: 'bad_verification_code' }, { status: 400 }),
    };

    await expect(
      exchangeStudioGithubOAuthCode({ code: 'bad-code', config, verifier: 'pkce-verifier' }),
    ).rejects.toThrow('GitHub authorization failed');
  });

  test('fails closed when the one-use GitHub token cannot be revoked', async () => {
    const config: StudioGithubOAuthConfig = {
      allowedUserId: 66_173_922,
      callbackUrl,
      clientId: 'Iv1.test-client',
      clientSecret: 'test-client-secret',
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/login/oauth/access_token')) {
          return Response.json({ access_token: 'ghu_temporary-token' });
        }
        if (url.endsWith('/user')) {
          return Response.json({ id: 66_173_922, login: 'GM2020JLU' });
        }
        if (url.includes('/applications/') && init?.method === 'DELETE') {
          return new Response(null, { status: 503 });
        }
        return new Response(null, { status: 404 });
      },
    };

    await expect(
      exchangeStudioGithubOAuthCode({ code: 'one-time-code', config, verifier: 'pkce-verifier' }),
    ).rejects.toThrow('token revocation failed');
  });
});
