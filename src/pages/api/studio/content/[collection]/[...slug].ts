import type { APIRoute } from 'astro';
import { z, ZodError } from 'zod';
import {
  defaultStudioMetadata,
  isStudioCollection,
  isTaxonomyCollection,
  parseStudioDocument,
  serializeStudioDocument,
  studioContentPath,
  studioPublicUrl,
  studioWriteSchema,
  StudioValidationError,
  validateStudioImageReferences,
  validateStudioTaxonomyReferences,
  type StudioPublicationStatus,
} from '../../../../../utils/studio-content';
import { generateStudioSlug } from '../../../../../utils/studio-slug';
import {
  findStudioTaxonomyReferences,
  StudioReferenceConflictError,
} from '../../../../../utils/studio-asset-references';
import {
  requireStudioToken,
  studioApiError,
  studioDeploymentMetadata,
  studioJson,
  studioUsesLocalDeployment,
  verifyStudioOrigin,
} from '../../../../../utils/studio-api';
import {
  deleteStudioFile,
  getStudioTaxonomies,
  readStudioFile,
  studioFileExists,
  StudioConflictError,
  writeStudioFile,
} from '../../../../../utils/studio-storage';

export const prerender = false;
const revisionSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i);
const deleteSchema = z
  .object({ expectedSha: revisionSchema.optional(), sha: revisionSchema.optional() })
  .refine((value) => Boolean(value.expectedSha || value.sha));

export function assertStudioContentSlug(routeSlug: string, nextSlug: string, isNew: boolean) {
  if (!isNew && nextSlug !== routeSlug) {
    throw Object.assign(new Error('现有内容的网址标识不能在编辑器中修改。'), { status: 400 });
  }
}

export async function resolveStudioCreateSlug(
  baseSlug: string,
  exists: (candidate: string) => Promise<boolean>,
) {
  for (let suffix = 1; suffix <= 99; suffix++) {
    const candidate = suffix === 1 ? baseSlug : `${baseSlug}-${suffix}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new StudioConflictError('同名内容过多，请调整标题后重试。');
}

export function studioContentNeedsDeployment(
  taxonomy: boolean,
  currentStatus?: StudioPublicationStatus,
  targetStatus?: StudioPublicationStatus,
) {
  return taxonomy || currentStatus === 'published' || targetStatus === 'published';
}

export function resolveStudioContentStatus(
  action: 'save' | 'draft' | 'ready' | 'publish' | 'unpublish' | 'schedule' | undefined,
  currentStatus: StudioPublicationStatus | undefined,
  metadataStatus: StudioPublicationStatus,
): StudioPublicationStatus {
  if (action === 'save') return currentStatus ?? metadataStatus;
  if (action === 'publish') return 'published';
  if (action === 'ready' || action === 'schedule') return 'ready';
  if (action === 'draft' || action === 'unpublish') return 'draft';
  return metadataStatus;
}

function publicationStatus(metadata: Record<string, unknown>): StudioPublicationStatus {
  return ['draft', 'ready', 'published'].includes(String(metadata.publicationStatus))
    ? (metadata.publicationStatus as StudioPublicationStatus)
    : metadata.draft === false
      ? 'published'
      : 'draft';
}

function routeParams(params: Record<string, string | undefined>) {
  const collection = params.collection ?? '';
  const slug = params.slug ?? '';
  if (!isStudioCollection(collection)) {
    throw Object.assign(new Error('不支持该内容类型。'), { status: 400 });
  }
  if (!slug) throw Object.assign(new Error('缺少内容标识。'), { status: 400 });
  return { collection, slug };
}

export const GET: APIRoute = async ({ params, cookies, url }) => {
  try {
    const { collection, slug } = routeParams(params);
    const token = requireStudioToken(cookies);
    const taxonomyOptions = isTaxonomyCollection(collection)
      ? Promise.resolve(undefined)
      : getStudioTaxonomies(token).then((taxonomies) =>
          Object.fromEntries(
            Object.entries(taxonomies).map(([key, values]) => [
              key,
              [...values].sort((left, right) => left.localeCompare(right, 'zh-CN')),
            ]),
          ),
        );
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
        taxonomies: await taxonomyOptions,
      });
    }
    const path = studioContentPath(collection, slug);
    const [file, taxonomies] = await Promise.all([readStudioFile(path, token), taxonomyOptions]);
    return studioJson({
      document: parseStudioDocument(collection, slug, file.content, file.sha),
      taxonomies,
    });
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
    const isNew = routeSlug === 'new';
    if (!isNew && !payload.expectedSha) {
      throw new StudioConflictError('缺少内容版本，请刷新后再保存。');
    }
    const generatedSlug = isTaxonomyCollection(collection)
      ? String(payload.metadata.title || '').trim()
      : generateStudioSlug(String(payload.metadata.title || ''));
    let slug =
      collection === 'about' ? 'about' : payload.slug.trim() || (isNew ? generatedSlug : routeSlug);
    assertStudioContentSlug(routeSlug, slug, isNew);
    if (isNew && collection !== 'about') {
      slug = await resolveStudioCreateSlug(slug, (candidate) =>
        studioFileExists(studioContentPath(collection, candidate), token),
      );
    }
    const currentPath = studioContentPath(collection, routeSlug);
    const nextPath = studioContentPath(collection, slug);
    let current;
    let currentStatus: StudioPublicationStatus | undefined;
    if (!isNew) {
      try {
        current = await readStudioFile(currentPath, token);
        currentStatus = publicationStatus(
          parseStudioDocument(collection, routeSlug, current.content, current.sha).metadata,
        );
      } catch (error) {
        const status = typeof error === 'object' && error && 'status' in error ? error.status : 0;
        const code = typeof error === 'object' && error && 'code' in error ? error.code : undefined;
        if (status !== 404 && code !== 'ENOENT') throw error;
      }
    }
    const targetStatus = resolveStudioContentStatus(
      payload.action,
      currentStatus,
      publicationStatus(payload.metadata),
    );
    const validateReferences =
      targetStatus !== 'draft' && !isTaxonomyCollection(collection)
        ? async () => {
            validateStudioTaxonomyReferences(payload.metadata, await getStudioTaxonomies(token));
            await validateStudioImageReferences(
              payload.metadata,
              payload.body,
              targetStatus,
              nextPath,
              (path) => studioFileExists(path, token),
            );
          }
        : undefined;
    await validateReferences?.();
    const content = serializeStudioDocument(
      collection,
      slug,
      payload.metadata,
      payload.body,
      targetStatus,
    );
    const verb =
      targetStatus === 'published' ? 'Publish' : targetStatus === 'ready' ? 'Mark ready' : 'Save';
    const deploymentRequired = studioContentNeedsDeployment(
      isTaxonomyCollection(collection),
      currentStatus,
      targetStatus,
    );
    const deploymentReason = `${verb} ${collection}: ${slug}`;
    const writeResult = await writeStudioFile({
      beforeWrite: validateReferences,
      token,
      path: nextPath,
      previousPath: current && currentPath !== nextPath ? currentPath : undefined,
      expectedSha: isNew ? null : payload.expectedSha,
      content,
      message: deploymentReason,
      deployment: studioUsesLocalDeployment
        ? { deploy: deploymentRequired, reason: deploymentReason }
        : undefined,
    });
    const deployment = await studioDeploymentMetadata({
      token,
      commitSha: writeResult.commitSha,
      deploy: deploymentRequired,
      localDeploymentId: writeResult.localDeploymentId,
      reason: deploymentReason,
    });
    return studioJson({
      ok: true,
      slug,
      path: nextPath,
      sha: writeResult.contentSha,
      status: targetStatus,
      publicUrl: targetStatus === 'published' ? studioPublicUrl(collection, slug) : undefined,
      ...deployment,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return studioJson({ error: error.issues[0]?.message ?? '内容字段校验失败。' }, 400);
    }
    if (error instanceof StudioValidationError) {
      return studioJson({ error: error.message }, 400);
    }
    return studioApiError(error);
  }
};

export const DELETE: APIRoute = async ({ params, cookies, request, url }) => {
  try {
    if (!verifyStudioOrigin(request, url)) return studioJson({ error: '请求来源不合法。' }, 403);
    const { collection, slug } = routeParams(params);
    if (collection === 'about') return studioJson({ error: '关于页面不能删除。' }, 400);
    const parsedDelete = deleteSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsedDelete.success) {
      return studioJson({ error: '缺少合法的内容版本，请刷新后再删除。' }, 400);
    }
    const expectedSha = parsedDelete.data.expectedSha ?? parsedDelete.data.sha!;
    const token = requireStudioToken(cookies);
    const path = studioContentPath(collection, slug);
    const file = await readStudioFile(path, token);
    if (file.sha !== expectedSha) throw new StudioConflictError();
    const document = parseStudioDocument(collection, slug, file.content, file.sha);
    const deploymentRequired = studioContentNeedsDeployment(
      isTaxonomyCollection(collection),
      publicationStatus(document.metadata),
    );
    const deploymentReason = `Delete ${collection}: ${slug}`;
    const deleted = await deleteStudioFile(path, expectedSha, token, {
      deployment: studioUsesLocalDeployment
        ? { deploy: deploymentRequired, reason: deploymentReason }
        : undefined,
      beforeDelete: isTaxonomyCollection(collection)
        ? async () => {
            const references = await findStudioTaxonomyReferences(
              collection as 'categories' | 'series' | 'tags',
              slug,
              token,
            );
            if (references.length) {
              throw new StudioReferenceConflictError(
                '该分类项仍被内容引用，请先移除引用后再删除。',
                'TAXONOMY_IN_USE',
                references,
              );
            }
          }
        : undefined,
    });
    const deployment = await studioDeploymentMetadata({
      token,
      commitSha: deleted.commitSha,
      deploy: deploymentRequired,
      localDeploymentId: deleted.localDeploymentId,
      reason: deploymentReason,
    });
    return studioJson({ ok: true, ...deployment });
  } catch (error) {
    if (error instanceof StudioReferenceConflictError) {
      return studioJson(
        { error: error.message, code: error.code, references: error.references },
        error.status,
      );
    }
    return studioApiError(error);
  }
};
