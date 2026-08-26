import type { APIRoute } from 'astro';
import { requireStudioToken, studioApiError, studioJson } from '../../../utils/studio-api';
import { getStudioDeployment } from '../../../utils/studio-storage';

export const prerender = false;

export const GET: APIRoute = async ({ cookies, url }) => {
  try {
    const targetSha = url.searchParams.get('sha') ?? undefined;
    if (targetSha && !/^[a-f0-9]{40}$/i.test(targetSha)) {
      return studioJson({ error: '部署提交标识不合法。' }, 400);
    }
    return studioJson({
      deployment: await getStudioDeployment(
        requireStudioToken(cookies),
        targetSha,
        import.meta.env.VERCEL_GIT_COMMIT_SHA || undefined,
      ),
    });
  } catch (error) {
    return studioApiError(error);
  }
};
