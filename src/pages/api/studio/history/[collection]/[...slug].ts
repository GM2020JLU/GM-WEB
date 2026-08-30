import type { APIRoute } from 'astro';
import {
  isStudioCollection,
  isTaxonomyCollection,
  parseStudioDocument,
  serializeStudioDocument,
  studioContentPath,
  studioPublicUrl,
  validateStudioImageReferences,
  validateStudioTaxonomyReferences,
  type StudioPublicationStatus,
} from '../../../../../utils/studio-content';
import {
  requireStudioToken,
  studioApiError,
  studioDeploymentMetadata,
  studioJson,
  verifyStudioOrigin,
} from '../../../../../utils/studio-api';
import {
  getStudioTaxonomies,
  listStudioHistory,
  readStudioFile,
  readStudioFileAtRef,
  studioFileExists,
  writeStudioFile,
} from '../../../../../utils/studio-storage';

export const prerender = false;

function pathFromParams(params: Record<string, string | undefined>) {
  const collection = params.collection ?? '';
  const slug = params.slug ?? '';
  if (!isStudioCollection(collection) || !slug) throw new Error('历史记录地址不合法。');
  return { collection, path: studioContentPath(collection, slug), slug };
}

export const GET: APIRoute = async ({ params, cookies }) => {
  try {
    const token = requireStudioToken(cookies);
    return studioJson({ history: await listStudioHistory(pathFromParams(params).path, token) });
  } catch (error) {
    return studioApiError(error);
  }
};

export const POST: APIRoute = async ({ params, cookies, request, url }) => {
  try {
    if (!verifyStudioOrigin(request, url)) return studioJson({ error: '请求来源不合法。' }, 403);
    const token = requireStudioToken(cookies);
    const body = (await request.json()) as { expectedSha?: string; ref?: string };
    if (!body.ref || !/^[a-f0-9]{7,40}$/i.test(body.ref)) {
      return studioJson({ error: '历史版本标识不合法。' }, 400);
    }
    if (!body.expectedSha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(body.expectedSha)) {
      return studioJson({ error: '内容版本标识不合法，请刷新后重试。' }, 400);
    }
    const { collection, path, slug } = pathFromParams(params);
    const [current, historical] = await Promise.all([
      readStudioFile(path, token),
      readStudioFileAtRef(path, body.ref, token),
    ]);
    const currentDocument = parseStudioDocument(collection, slug, current.content, current.sha);
    const historicalDocument = parseStudioDocument(collection, slug, historical);
    const publicationStatus = (document: typeof currentDocument): StudioPublicationStatus =>
      ['draft', 'ready', 'published'].includes(String(document.metadata.publicationStatus))
        ? (document.metadata.publicationStatus as StudioPublicationStatus)
        : document.metadata.draft === false
          ? 'published'
          : 'draft';
    const currentStatus = publicationStatus(currentDocument);
    const restoredStatus = publicationStatus(historicalDocument);
    const validateReferences =
      restoredStatus !== 'draft' && !isTaxonomyCollection(collection)
        ? async () => {
            validateStudioTaxonomyReferences(
              historicalDocument.metadata,
              await getStudioTaxonomies(token),
            );
            await validateStudioImageReferences(
              historicalDocument.metadata,
              historicalDocument.body,
              restoredStatus,
              path,
              (referencePath) => studioFileExists(referencePath, token),
            );
          }
        : undefined;
    await validateReferences?.();
    const restoredContent = serializeStudioDocument(
      collection,
      slug,
      historicalDocument.metadata,
      historicalDocument.body,
      restoredStatus,
    );
    const written = await writeStudioFile({
      beforeWrite: validateReferences,
      token,
      path,
      expectedSha: body.expectedSha,
      content: restoredContent,
      message: `Restore ${path} from ${body.ref.slice(0, 7)}`,
    });
    const deployment = await studioDeploymentMetadata({
      token,
      commitSha: written.commitSha,
      deploy:
        isTaxonomyCollection(collection) ||
        currentStatus === 'published' ||
        restoredStatus === 'published',
      reason: `Restore ${collection}: ${slug}`,
    });
    return studioJson({
      ok: true,
      sha: written.contentSha,
      status: restoredStatus,
      publicUrl: restoredStatus === 'published' ? studioPublicUrl(collection, slug) : undefined,
      ...deployment,
    });
  } catch (error) {
    return studioApiError(error);
  }
};
