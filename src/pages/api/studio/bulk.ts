import type { APIRoute } from 'astro';
import { z, ZodError } from 'zod';
import {
  assertStudioBulkRevision,
  assertUniqueStudioBulkItems,
  studioBulkNeedsDeployment,
  studioBulkStatusByAction,
} from '../../../utils/studio-bulk';
import {
  isStudioCollection,
  isTaxonomyCollection,
  parseStudioDocument,
  serializeStudioDocument,
  studioContentPath,
  StudioValidationError,
  validateStudioImageReferences,
  validateStudioTaxonomyReferences,
  type StudioPublicationStatus,
} from '../../../utils/studio-content';
import {
  requireStudioToken,
  studioApiError,
  studioDeploymentMetadata,
  studioJson,
  verifyStudioOrigin,
} from '../../../utils/studio-api';
import {
  getStudioTaxonomies,
  readStudioFile,
  studioFileExists,
  writeStudioFile,
} from '../../../utils/studio-storage';

export const prerender = false;

const schema = z.object({
  action: z.enum(['draft', 'ready', 'publish', 'unpublish']),
  items: z
    .array(
      z.object({
        collection: z.string(),
        expectedUpdatedDate: z.string().optional(),
        slug: z.string(),
      }),
    )
    .min(1)
    .max(50),
});

export const POST: APIRoute = async ({ cookies, request, url }) => {
  try {
    if (!verifyStudioOrigin(request, url)) return studioJson({ error: '请求来源不合法。' }, 403);
    const token = requireStudioToken(cookies);
    const payload = schema.parse(await request.json());
    assertUniqueStudioBulkItems(payload.items);
    const status = studioBulkStatusByAction[payload.action];
    const results: Array<{ collection: string; slug: string }> = [];
    let commitSha: string | undefined;
    const taxonomies = status === 'draft' ? undefined : await getStudioTaxonomies(token);
    const planned: Array<{
      collection: string;
      content: string;
      currentStatus: StudioPublicationStatus;
      path: string;
      sha?: string;
      slug: string;
      validateReferences?: () => Promise<void>;
    }> = [];

    // Read, validate and serialize the whole batch before the first write. A bad later
    // item can no longer leave earlier items silently changed.
    for (const item of payload.items) {
      if (!isStudioCollection(item.collection) || isTaxonomyCollection(item.collection)) {
        throw new Error('批量操作包含不支持的内容类型。');
      }
      const path = studioContentPath(item.collection, item.slug);
      const file = await readStudioFile(path, token);
      const document = parseStudioDocument(item.collection, item.slug, file.content, file.sha);
      assertStudioBulkRevision(
        item.expectedUpdatedDate,
        document.metadata.updatedDate,
        String(document.metadata.title || item.slug),
      );
      const validateReferences =
        status !== 'draft'
          ? async () => {
              if (taxonomies) validateStudioTaxonomyReferences(document.metadata, taxonomies);
              await validateStudioImageReferences(
                document.metadata,
                document.body,
                status,
                path,
                (referencePath) => studioFileExists(referencePath, token),
              );
            }
          : undefined;
      await validateReferences?.();
      const content = serializeStudioDocument(
        item.collection,
        item.slug,
        document.metadata,
        document.body,
        status,
      );
      const currentStatus = ['draft', 'ready', 'published'].includes(
        String(document.metadata.publicationStatus),
      )
        ? (document.metadata.publicationStatus as StudioPublicationStatus)
        : document.metadata.draft === false
          ? 'published'
          : 'draft';
      planned.push({
        collection: item.collection,
        content,
        currentStatus,
        path,
        sha: file.sha,
        slug: item.slug,
        validateReferences,
      });
    }

    let writeFailure: unknown;
    for (const item of planned) {
      try {
        const written = await writeStudioFile({
          beforeWrite: item.validateReferences,
          token,
          path: item.path,
          expectedSha: item.sha,
          content: item.content,
          message: `Bulk ${payload.action} ${item.collection}: ${item.slug}`,
        });
        commitSha = written.commitSha ?? commitSha;
        results.push({ collection: item.collection, slug: item.slug });
      } catch (error) {
        writeFailure = error;
        break;
      }
    }

    if (writeFailure && results.length === 0) return studioApiError(writeFailure);

    const shouldDeploy = studioBulkNeedsDeployment(
      status,
      planned.slice(0, results.length).map((item) => item.currentStatus),
    );

    let deployment: Awaited<ReturnType<typeof studioDeploymentMetadata>> = {
      commitSha,
      deploymentPending: false,
      deploymentProvider: 'vercel',
    };
    let deploymentFailure = false;
    if (results.length) {
      try {
        deployment = await studioDeploymentMetadata({
          token,
          commitSha,
          deploy: shouldDeploy,
          reason: `Bulk ${payload.action}: ${results.length} entries`,
        });
      } catch {
        deploymentFailure = true;
      }
    }

    if (writeFailure || deploymentFailure) {
      return studioJson(
        {
          ok: false,
          partial: results.length > 0,
          error: results.length
            ? deploymentFailure
              ? `已更新 ${results.length} 条内容，但未能启动网站更新，请重试发布。`
              : `已更新 ${results.length} 条内容，后续操作遇到冲突，请刷新后重试剩余内容。`
            : writeFailure instanceof Error
              ? writeFailure.message
              : '批量操作失败。',
          status,
          updated: results.length,
          updatedItems: results,
          ...deployment,
        },
        207,
      );
    }

    return studioJson({
      ok: true,
      status,
      updated: results.length,
      ...deployment,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return studioJson({ error: error.issues[0]?.message ?? '批量操作字段校验失败。' }, 400);
    }
    if (error instanceof StudioValidationError) {
      return studioJson({ error: error.message }, 400);
    }
    return studioApiError(error);
  }
};
