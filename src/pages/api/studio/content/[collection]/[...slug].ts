import type { APIRoute } from 'astro';
import { ZodError } from 'zod';
import {
  defaultStudioMetadata,
  isStudioCollection,
  parseStudioDocument,
  serializeStudioDocument,
  studioContentPath,
  studioPublicUrl,
  studioWriteSchema,
  type StudioPublicationStatus,
} from '../../../../../utils/studio-content';
import {
  requireStudioToken,
  studioApiError,
  studioJson,
  verifyStudioOrigin,
} from '../../../../../utils/studio-api';
import {
  deleteStudioFile,
  readStudioFile,
  writeStudioFile,
} from '../../../../../utils/studio-storage';

export const prerender = false;

function routeParams(params: Record<string, string | undefined>) {
  const collection = params.collection ?? '';
  const slug = params.slug ?? '';
  if (!isStudioCollection(collection)) throw new Error('不支持该内容类型。');
  if (!slug) throw new Error('缺少内容标识。');
  return { collection, slug };
}

export const GET: APIRoute = async ({ params, cookies, url }) => {
  try {
    const { collection, slug } = routeParams(params);
    const token = requireStudioToken(cookies);
    if (url.searchParams.get('new') === '1') {
      return studioJson({
        document: {
          body: '',
          collection,
          metadata: defaultStudioMetadata(collection),
          path: studioContentPath(collection, slug),
          slug,
        },
        isNew: true,
      });
    }
    const path = studioContentPath(collection, slug);
    const file = await readStudioFile(path, token);
    return studioJson({ document: parseStudioDocument(collection, slug, file.content, file.sha) });
  } catch (error) {
    return studioApiError(error);
  }
};

export const PUT: APIRoute = async ({ params, cookies, request, url }) => {
  try {
    if (!verifyStudioOrigin(request, url)) return studioJson({ error: '请求来源不合法。' }, 403);
    if (Number(request.headers.get('content-length') || 0) > 2_500_000) {
      return studioJson({ error: '内容请求过大。' }, 413);
    }
    const { collection, slug: routeSlug } = routeParams(params);
    const token = requireStudioToken(cookies);
    const payload = studioWriteSchema.parse(await request.json());
    const slug = collection === 'about' ? 'about' : payload.slug;
    const currentPath = studioContentPath(collection, routeSlug);
    const nextPath = studioContentPath(collection, slug);
    let current;
    try {
      current = await readStudioFile(currentPath, token);
    } catch (error) {
      const status = typeof error === 'object' && error && 'status' in error ? error.status : 0;
      if (status !== 404 && token) throw error;
    }
    const actionStatus: Record<string, StudioPublicationStatus> = {
      draft: 'draft',
      ready: 'ready',
      publish: 'published',
      unpublish: 'draft',
      schedule: 'ready',
    };
    const status = payload.action
      ? actionStatus[payload.action]
      : (payload.metadata.publicationStatus as StudioPublicationStatus | undefined);
    const content = serializeStudioDocument(
      collection,
      slug,
      payload.metadata,
      payload.body,
      status,
    );
    const verb = status === 'published' ? 'Publish' : status === 'ready' ? 'Mark ready' : 'Save';
    await writeStudioFile({
      token,
      path: nextPath,
      previousPath: current && currentPath !== nextPath ? currentPath : undefined,
      sha: currentPath === nextPath ? current?.sha : undefined,
      content,
      message: `${verb} ${collection}: ${slug}`,
    });
    return studioJson({
      ok: true,
      slug,
      path: nextPath,
      status: status ?? 'draft',
      publicUrl: status === 'published' ? studioPublicUrl(collection, slug) : undefined,
      deploymentPending: Boolean(token),
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return studioJson({ error: error.issues[0]?.message ?? '内容字段校验失败。' }, 400);
    }
    return studioApiError(error);
  }
};

export const DELETE: APIRoute = async ({ params, cookies, request, url }) => {
  try {
    if (!verifyStudioOrigin(request, url)) return studioJson({ error: '请求来源不合法。' }, 403);
    const { collection, slug } = routeParams(params);
    if (collection === 'about') return studioJson({ error: '关于页面不能删除。' }, 400);
    const token = requireStudioToken(cookies);
    const path = studioContentPath(collection, slug);
    const file = await readStudioFile(path, token);
    await deleteStudioFile(path, file.sha, token);
    return studioJson({ ok: true });
  } catch (error) {
    return studioApiError(error);
  }
};
