import type { AstroCookies } from 'astro';
import { startStudioLocalDeployment } from './studio-local-deployment';

const studioProxyHosts = new Set([
  'goumin-mac.tailfc8e48.ts.net',
  'mac-preview.goumin.work',
  'studio.goumin.work',
]);
const requestedStorage = import.meta.env.PUBLIC_KEYSTATIC_STORAGE_KIND;
export const studioUsesGitHub =
  requestedStorage === 'github' || (requestedStorage !== 'local' && import.meta.env.PROD);
export const studioUsesLocalDeployment =
  requestedStorage === 'local' && import.meta.env.PUBLIC_STUDIO_DEPLOYMENT_MODE === 'local';

export async function studioDeploymentMetadata(input: {
  commitSha?: string;
  deploy: boolean;
  reason: string;
  token?: string;
}) {
  if (studioUsesLocalDeployment && input.deploy) {
    return {
      commitSha: await startStudioLocalDeployment(input.reason),
      deploymentPending: true,
      deploymentProvider: 'local' as const,
    };
  }
  return {
    commitSha: input.commitSha,
    deploymentPending: Boolean(input.token && input.deploy),
    deploymentProvider: 'vercel' as const,
  };
}

export function studioJson(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
    },
  });
}

export function verifyStudioOrigin(request: Request, url: URL) {
  const origin = request.headers.get('origin');
  if (!origin && !import.meta.env.PROD) return true;
  if (origin === url.origin) return true;

  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  if (
    forwardedHost &&
    (forwardedProto === 'http' || forwardedProto === 'https') &&
    origin === `${forwardedProto}://${forwardedHost}`
  ) {
    return true;
  }

  const requestHost = request.headers.get('host')?.toLowerCase();
  return Boolean(
    requestHost && studioProxyHosts.has(requestHost) && origin === `https://${requestHost}`,
  );
}

export function studioToken(cookies: AstroCookies) {
  return cookies.get('keystatic-gh-access-token')?.value;
}

export function requireStudioToken(cookies: AstroCookies) {
  const token = studioToken(cookies);
  if (studioUsesGitHub && !token) {
    throw new StudioAuthenticationError();
  }
  return token;
}

export class StudioAuthenticationError extends Error {
  constructor() {
    super('请先使用 GM2020JLU 登录创作后台。');
    this.name = 'StudioAuthenticationError';
  }
}

export function studioApiError(error: unknown) {
  if (error instanceof StudioAuthenticationError) {
    return studioJson(
      {
        error: error.message,
        loginUrl: '/api/keystatic/github/login?from=branch/main',
      },
      401,
    );
  }
  const status =
    typeof error === 'object' && error && 'status' in error && typeof error.status === 'number'
      ? error.status
      : 500;
  const code = typeof error === 'object' && error && 'code' in error ? error.code : undefined;
  if (status === 404 || code === 'ENOENT') {
    return studioJson({ error: '内容不存在或尚未完成部署。' }, 404);
  }
  if (status === 400) {
    return studioJson({ error: error instanceof Error ? error.message : '请求参数不合法。' }, 400);
  }
  if (status === 401) return studioJson({ error: 'GitHub 登录已过期，请重新登录。' }, 401);
  if (status === 403) return studioJson({ error: '当前账号没有 GM-WEB 写入权限。' }, 403);
  if (status === 409 || status === 422) {
    return studioJson({ error: '内容已被修改或同名内容已经存在，请刷新后重试。' }, 409);
  }
  console.error('Studio API failed', error);
  return studioJson({ error: error instanceof Error ? error.message : '后台操作失败。' }, 500);
}
