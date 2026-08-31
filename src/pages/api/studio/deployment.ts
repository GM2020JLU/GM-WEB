import type { APIRoute } from 'astro';
import {
  requireStudioToken,
  studioApiError,
  studioJson,
  studioUsesLocalDeployment,
} from '../../../utils/studio-api';
import { readStudioLocalDeployment } from '../../../utils/studio-local-deployment';
import { readStudioLocalSchedulerState } from '../../../utils/studio-local-scheduler';
import { getStudioDeployment } from '../../../utils/studio-storage';
import { readProductionBuildSha } from '../../../utils/studio-deployment';
import { readStudioPlatformHealth } from '../../../utils/studio-platform-health';

export const prerender = false;

export const GET: APIRoute = async ({ cookies, url }) => {
  try {
    const targetSha = url.searchParams.get('sha') ?? undefined;
    if (targetSha && !/^[a-f0-9]{40}$/i.test(targetSha)) {
      return studioJson({ error: '部署提交标识不合法。' }, 400);
    }
    const deployment = studioUsesLocalDeployment
      ? await readStudioLocalDeployment(targetSha)
      : await getStudioDeployment(
          requireStudioToken(cookies),
          targetSha,
          await readProductionBuildSha().catch(() => undefined),
        );
    // Detailed task polling stays independent from the slower external marker
    // probe. The dashboard issues a separate no-sha request for platform health.
    const health = targetSha ? undefined : await readStudioPlatformHealth();
    return studioJson({
      deployment,
      ...(health ? { health } : {}),
      ...(studioUsesLocalDeployment ? { scheduler: await readStudioLocalSchedulerState() } : {}),
    });
  } catch (error) {
    return studioApiError(error);
  }
};
