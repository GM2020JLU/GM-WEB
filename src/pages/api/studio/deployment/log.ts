import type { APIRoute } from 'astro';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  requireStudioToken,
  studioApiError,
  studioUsesLocalDeployment,
} from '../../../../utils/studio-api';

export const prerender = false;

export const GET: APIRoute = async ({ cookies, url }) => {
  try {
    requireStudioToken(cookies);
    if (!studioUsesLocalDeployment) return new Response('本地部署日志未启用。', { status: 404 });
    const targetSha = url.searchParams.get('sha') || '';
    if (!/^[a-f0-9]{40}$/.test(targetSha)) {
      return new Response('部署任务标识不合法。', { status: 400 });
    }
    const runtime = resolve(process.cwd(), process.env.STUDIO_RUNTIME_DIR || '.studio/runtime');
    const content = await readFile(resolve(runtime, 'deployments', `${targetSha}.log`), 'utf8');
    return new Response(content, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    return studioApiError(error);
  }
};
