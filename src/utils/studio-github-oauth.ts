const encoder = new TextEncoder();
const decoder = new TextDecoder();
const OAUTH_HMAC_CONTEXT = 'studio-github-oauth:v1:';

export const STUDIO_GITHUB_OAUTH_COOKIE = '__Host-goumin-studio-github';
export const STUDIO_GITHUB_OAUTH_TTL_SECONDS = 10 * 60;

export type StudioGithubFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type StudioGithubOAuthConfig = {
  allowedUserId: number;
  callbackUrl: string;
  clientId: string;
  clientSecret: string;
  fetch?: StudioGithubFetch;
};

type GithubOAuthTransactionInput = {
  callbackUrl: string;
  clientId: string;
  nextPath: string;
  now?: number;
  randomBytes?: (length: number) => Uint8Array;
  secret: string;
  ttlSeconds?: number;
};

type GithubOAuthVerificationInput = {
  cookieValue: string | undefined;
  now?: number;
  secret: string;
  state: string | null;
};

type GithubOAuthIdentity = {
  id: number;
  login: string;
};

function base64Url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString('base64url');
}

function decodeBase64Url(value: string) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const bytes = new Uint8Array(Buffer.from(value, 'base64url'));
    return base64Url(bytes) === value.replace(/=+$/, '') ? bytes : null;
  } catch {
    return null;
  }
}

async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

async function verifyHmac(secret: string, value: string, signature: Uint8Array) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('HMAC', key, new Uint8Array(signature), encoder.encode(value));
}

function oauthHmacValue(payload: string) {
  return `${OAUTH_HMAC_CONTEXT}${payload}`;
}

async function sameValue(left: string, right: string) {
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = left.length ^ right.length;
  for (let index = 0; index < leftBytes.length; index++) {
    difference |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return difference === 0;
}

export async function createStudioGithubOAuthTransaction(input: GithubOAuthTransactionInput) {
  const now = input.now ?? Date.now();
  const ttlSeconds = input.ttlSeconds ?? STUDIO_GITHUB_OAUTH_TTL_SECONDS;
  const randomBytes =
    input.randomBytes ?? ((length: number) => crypto.getRandomValues(new Uint8Array(length)));
  const state = base64Url(randomBytes(32));
  const verifier = base64Url(randomBytes(32));
  const nextPath = base64Url(encoder.encode(input.nextPath));
  const expiresAt = Math.floor(now / 1_000) + ttlSeconds;
  const payload = `v1.${expiresAt}.${state}.${nextPath}.${verifier}`;
  const cookieValue = `${payload}.${base64Url(await hmac(input.secret, oauthHmacValue(payload)))}`;
  const challenge = base64Url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))),
  );
  const authorizeUrl = new URL('https://github.com/login/oauth/authorize');
  authorizeUrl.searchParams.set('client_id', input.clientId);
  authorizeUrl.searchParams.set('redirect_uri', input.callbackUrl);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('allow_signup', 'false');

  return { authorizeUrl: authorizeUrl.toString(), cookieValue, state };
}

export async function verifyStudioGithubOAuthTransaction(input: GithubOAuthVerificationInput) {
  if (
    !input.cookieValue ||
    input.cookieValue.length > 2_048 ||
    !input.state ||
    input.state.length !== 43
  ) {
    return null;
  }
  const parts = input.cookieValue.split('.');
  if (parts.length !== 6 || parts[0] !== 'v1') return null;
  const [version, rawExpiresAt, storedState, encodedNextPath, verifier, encodedSignature] = parts;
  const expiresAt = Number(rawExpiresAt);
  const nextPathBytes = decodeBase64Url(encodedNextPath ?? '');
  const verifierBytes = decodeBase64Url(verifier ?? '');
  const signature = decodeBase64Url(encodedSignature ?? '');
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Math.floor((input.now ?? Date.now()) / 1_000) ||
    storedState?.length !== 43 ||
    verifierBytes?.length !== 32 ||
    signature?.length !== 32 ||
    !nextPathBytes ||
    nextPathBytes.length > 1_024
  ) {
    return null;
  }
  const payload = [version, rawExpiresAt, storedState, encodedNextPath, verifier].join('.');
  const [validSignature, matchingState] = await Promise.all([
    verifyHmac(input.secret, oauthHmacValue(payload), signature),
    sameValue(storedState, input.state),
  ]);
  if (!validSignature || !matchingState) return null;

  return {
    expiresAt,
    nextPath: decoder.decode(nextPathBytes),
    state: storedState,
    verifier,
  };
}

async function readSmallJson(response: Response) {
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new Error('GitHub returned an unexpected response.');
  }
  if (!response.body) throw new Error('GitHub returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 16_384) {
      await reader.cancel();
      throw new Error('GitHub returned an oversized response.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const body = decoder.decode(bytes);
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new Error('GitHub returned an invalid response.');
  }
}

async function revokeGithubToken(
  request: StudioGithubFetch,
  config: StudioGithubOAuthConfig,
  accessToken: string,
) {
  const response = await request(
    `https://api.github.com/applications/${encodeURIComponent(config.clientId)}/token`,
    {
      body: JSON.stringify({ access_token: accessToken }),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
        'User-Agent': 'goumin-work-studio-auth',
        'X-GitHub-Api-Version': '2026-03-10',
      },
      method: 'DELETE',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (response.status !== 204) {
    throw new Error('GitHub temporary token revocation failed.');
  }
}

export async function exchangeStudioGithubOAuthCode(input: {
  code: string;
  config: StudioGithubOAuthConfig;
  verifier: string;
}): Promise<GithubOAuthIdentity> {
  if (!input.code || input.code.length > 512) throw new Error('Invalid GitHub authorization code.');
  const request = input.config.fetch ?? globalThis.fetch;
  const tokenResponse = await request('https://github.com/login/oauth/access_token', {
    body: new URLSearchParams({
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.config.callbackUrl,
    }),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'goumin-work-studio-auth',
    },
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  const tokenData = await readSmallJson(tokenResponse);
  const accessToken = tokenData.access_token;
  if (typeof accessToken !== 'string' || accessToken.length > 512) {
    throw new Error('GitHub authorization failed.');
  }

  try {
    if (!tokenResponse.ok) throw new Error('GitHub authorization failed.');
    const userResponse = await request('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'goumin-work-studio-auth',
        'X-GitHub-Api-Version': '2026-03-10',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    const user = await readSmallJson(userResponse);
    if (
      !userResponse.ok ||
      typeof user.id !== 'number' ||
      !Number.isSafeInteger(user.id) ||
      typeof user.login !== 'string' ||
      user.login.length > 80
    ) {
      throw new Error('GitHub identity lookup failed.');
    }
    return { id: user.id, login: user.login };
  } finally {
    await revokeGithubToken(request, input.config, accessToken);
  }
}
