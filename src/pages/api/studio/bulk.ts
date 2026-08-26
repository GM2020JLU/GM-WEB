import type { APIRoute } from 'astro';
import { z } from 'zod';
import {
  isStudioCollection,
  isTaxonomyCollection,
  parseStudioDocument,
  serializeStudioDocument,
  studioContentPath,
  type StudioPublicationStatus,
} from '../../../utils/studio-content';
import {
  requireStudioToken,
  studioApiError,
  studioJson,
  verifyStudioOrigin,
} from '../../../utils/studio-api';
import { readStudioFile, writeStudioFile } from '../../../utils/studio-storage';

export const prerender = false;

const schema = z.object({
  action: z.enum(['draft', 'ready', 'publish', 'unpublish']),
  items: z
    .array(z.object({ collection: z.string(), slug: z.string() }))
    .min(1)
    .max(50),
});

const statusByAction: Record<string, StudioPublicationStatus> = {
  draft: 'draft',
  ready: 'ready',
  publish: 'published',
  unpublish: 'draft',
};

export const POST: APIRoute = async ({ cookies, request, url }) => {
  try {
    if (!verifyStudioOrigin(request, url)) return studioJson({ error: '请求来源不合法。' }, 403);
    const token = requireStudioToken(cookies);
    const payload = schema.parse(await request.json());
    const status = statusByAction[payload.action];
    const results: Array<{ collection: string; slug: string }> = [];
    for (const item of payload.items) {
      if (!isStudioCollection(item.collection) || isTaxonomyCollection(item.collection)) {
        throw new Error('批量操作包含不支持的内容类型。');
      }
      const path = studioContentPath(item.collection, item.slug);
      const file = await readStudioFile(path, token);
      const document = parseStudioDocument(item.collection, item.slug, file.content, file.sha);
      const content = serializeStudioDocument(
        item.collection,
        item.slug,
        document.metadata,
        document.body,
        status,
      );
      await writeStudioFile({
        token,
        path,
        sha: file.sha,
        content,
        message: `Bulk ${payload.action} ${item.collection}: ${item.slug}`,
      });
      results.push(item);
    }
    return studioJson({
      ok: true,
      status,
      updated: results.length,
      deploymentPending: Boolean(token),
    });
  } catch (error) {
    return studioApiError(error);
  }
};
