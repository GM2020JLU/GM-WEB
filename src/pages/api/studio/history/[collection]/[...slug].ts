import type { APIRoute } from 'astro';
import { isStudioCollection, studioContentPath } from '../../../../../utils/studio-content';
import {
  requireStudioToken,
  studioApiError,
  studioJson,
  verifyStudioOrigin,
} from '../../../../../utils/studio-api';
import {
  listStudioHistory,
  readStudioFile,
  readStudioFileAtRef,
  writeStudioFile,
} from '../../../../../utils/studio-storage';

export const prerender = false;

function pathFromParams(params: Record<string, string | undefined>) {
  const collection = params.collection ?? '';
  const slug = params.slug ?? '';
  if (!isStudioCollection(collection) || !slug) throw new Error('历史记录地址不合法。');
  return studioContentPath(collection, slug);
}

export const GET: APIRoute = async ({ params, cookies }) => {
  try {
    const token = requireStudioToken(cookies);
    return studioJson({ history: await listStudioHistory(pathFromParams(params), token) });
  } catch (error) {
    return studioApiError(error);
  }
};

export const POST: APIRoute = async ({ params, cookies, request, url }) => {
  try {
    if (!verifyStudioOrigin(request, url)) return studioJson({ error: '请求来源不合法。' }, 403);
    const token = requireStudioToken(cookies);
    const body = (await request.json()) as { ref?: string };
    if (!body.ref || !/^[a-f0-9]{7,40}$/i.test(body.ref)) {
      return studioJson({ error: '历史版本标识不合法。' }, 400);
    }
    const path = pathFromParams(params);
    const [current, historical] = await Promise.all([
      readStudioFile(path, token),
      readStudioFileAtRef(path, body.ref, token),
    ]);
    await writeStudioFile({
      token,
      path,
      sha: current.sha,
      content: historical,
      message: `Restore ${path} from ${body.ref.slice(0, 7)}`,
    });
    return studioJson({ ok: true });
  } catch (error) {
    return studioApiError(error);
  }
};
