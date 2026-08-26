import type { APIRoute } from 'astro';
import { requireStudioToken, studioApiError, studioJson } from '../../../utils/studio-api';
import { getStudioDeployment } from '../../../utils/studio-storage';

export const prerender = false;

export const GET: APIRoute = async ({ cookies }) => {
  try {
    return studioJson({ deployment: await getStudioDeployment(requireStudioToken(cookies)) });
  } catch (error) {
    return studioApiError(error);
  }
};
