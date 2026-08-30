#!/usr/bin/env bun

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createStudioAuthService,
  STUDIO_AUTH_MAX_REQUEST_BODY_SIZE,
} from '../src/utils/studio-auth-gateway';

async function readCredential(path: string | undefined, label: string, minimumLength: number) {
  if (!path) throw new Error(`${label} file path is required.`);
  const resolvedPath = resolve(path);
  const metadata = await stat(resolvedPath);
  if (!metadata.isFile()) throw new Error(`${label} path must point to a file.`);
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new Error(`${label} file must be owned by the Studio service user.`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`${label} file permissions must be 0600 or stricter.`);
  }
  const value = (await readFile(resolvedPath, 'utf8')).replace(/[\r\n]+$/, '');
  if (value.length < minimumLength) throw new Error(`${label} is unexpectedly short.`);
  return value;
}

function randomBytes(length: number) {
  return crypto.getRandomValues(new Uint8Array(length));
}

const host = process.env.STUDIO_AUTH_HOST || '127.0.0.1';
const port = Number(process.env.STUDIO_AUTH_PORT || 4322);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error('STUDIO_AUTH_PORT must be a valid TCP port.');
}
const publicHost = process.env.STUDIO_AUTH_PUBLIC_HOST || 'studio.goumin.work';
const githubSettings = {
  allowedUserId: process.env.STUDIO_GITHUB_ALLOWED_USER_ID,
  callbackUrl: process.env.STUDIO_GITHUB_CALLBACK_URL,
  clientIdFile: process.env.STUDIO_GITHUB_CLIENT_ID_FILE,
  clientSecretFile: process.env.STUDIO_GITHUB_CLIENT_SECRET_FILE,
};
const githubSettingCount = Object.values(githubSettings).filter(Boolean).length;
if (githubSettingCount !== 0 && githubSettingCount !== Object.keys(githubSettings).length) {
  throw new Error('GitHub login settings must be configured together.');
}
const githubEnabled = githubSettingCount > 0;

const [password, sessionSecret, mapleMono, studioChinese, githubClientId, githubClientSecret] =
  await Promise.all([
    readCredential(process.env.STUDIO_AUTH_PASSWORD_FILE, 'Studio password', 16),
    readCredential(process.env.STUDIO_AUTH_SECRET_FILE, 'Studio session secret', 32),
    readFile(
      new URL(
        '../node_modules/@fontsource/maple-mono/files/maple-mono-latin-500-normal.woff2',
        import.meta.url,
      ),
    ),
    readFile(
      new URL('../public/fonts/LXGWWenKai-Regular-content-subset-ui-subset.woff2', import.meta.url),
    ).catch(() => null),
    githubEnabled
      ? readCredential(githubSettings.clientIdFile, 'Studio GitHub client ID', 12)
      : Promise.resolve(undefined),
    githubEnabled
      ? readCredential(githubSettings.clientSecretFile, 'Studio GitHub client secret', 32)
      : Promise.resolve(undefined),
  ]);

let github:
  | {
      allowedUserId: number;
      callbackUrl: string;
      clientId: string;
      clientSecret: string;
    }
  | undefined;
if (githubEnabled) {
  const allowedUserId = Number(githubSettings.allowedUserId);
  if (!Number.isSafeInteger(allowedUserId) || allowedUserId <= 0) {
    throw new Error('STUDIO_GITHUB_ALLOWED_USER_ID must be a positive numeric GitHub user ID.');
  }
  const callback = new URL(githubSettings.callbackUrl!);
  if (
    callback.protocol !== 'https:' ||
    callback.host.toLowerCase() !== publicHost.toLowerCase() ||
    callback.pathname !== '/api/studio/auth/github/callback' ||
    callback.username ||
    callback.password ||
    callback.search ||
    callback.hash
  ) {
    throw new Error('STUDIO_GITHUB_CALLBACK_URL must be the exact public Studio callback URL.');
  }
  github = {
    allowedUserId,
    callbackUrl: callback.toString(),
    clientId: githubClientId!,
    clientSecret: githubClientSecret!,
  };
}

const loginAssets: Record<string, { body: BodyInit; contentType: string }> = {
  '/studio/login-assets/maple-mono.woff2': {
    body: mapleMono,
    contentType: 'font/woff2',
  },
};
if (studioChinese) {
  loginAssets['/studio/login-assets/studio-cn.woff2'] = {
    body: studioChinese,
    contentType: 'font/woff2',
  };
}

const handleRequest = createStudioAuthService({
  github,
  loginAssets,
  password,
  passwordLogin: 'loopback',
  publicHost,
  randomBytes,
  sessionSecret,
  username: process.env.STUDIO_AUTH_USERNAME || 'goumin',
});

Bun.serve({
  development: false,
  error(error) {
    console.error('Studio authentication service failed to handle a request', error);
    return new Response('Authentication service unavailable', {
      headers: {
        'Cache-Control': 'private, no-store',
        'CDN-Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
      status: 500,
    });
  },
  fetch: handleRequest,
  hostname: host,
  maxRequestBodySize: STUDIO_AUTH_MAX_REQUEST_BODY_SIZE,
  port,
});

console.log(`Studio authentication service listening on http://${host}:${port}`);
