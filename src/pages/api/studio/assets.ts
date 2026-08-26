import type { APIRoute } from 'astro';
import sharp from 'sharp';
import {
  requireStudioToken,
  studioApiError,
  studioJson,
  verifyStudioOrigin,
} from '../../../utils/studio-api';
import {
  deleteStudioFile,
  listStudioAssets,
  writeStudioBinaryFile,
} from '../../../utils/studio-storage';

export const prerender = false;

const extensions: Record<string, string> = {
  jpeg: 'jpg',
  jpg: 'jpg',
  png: 'png',
  webp: 'webp',
  gif: 'gif',
  avif: 'avif',
};

export const GET: APIRoute = async ({ cookies }) => {
  try {
    return studioJson({ assets: await listStudioAssets(requireStudioToken(cookies)) });
  } catch (error) {
    return studioApiError(error);
  }
};

export const POST: APIRoute = async ({ cookies, request, url }) => {
  try {
    if (!verifyStudioOrigin(request, url)) return studioJson({ error: '请求来源不合法。' }, 403);
    if (Number(request.headers.get('content-length') || 0) > 5_500_000) {
      return studioJson({ error: '图片上传请求不能超过 5 MB。' }, 413);
    }
    const token = requireStudioToken(cookies);
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return studioJson({ error: '请选择图片文件。' }, 400);
    if (file.size > 5 * 1024 * 1024) return studioJson({ error: '图片不能超过 5 MB。' }, 413);
    const buffer = Buffer.from(await file.arrayBuffer());
    const metadata = await sharp(buffer, { animated: true }).metadata();
    const extension = metadata.format ? extensions[metadata.format] : undefined;
    if (!extension) return studioJson({ error: '仅支持 JPG、PNG、WebP、GIF 和 AVIF。' }, 400);
    const stem =
      file.name
        .replace(/\.[^.]+$/, '')
        .toLocaleLowerCase('en-US')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || `image-${Date.now()}`;
    const path = `src/assets/images/content/${stem}.${extension}`;
    try {
      const existing = await listStudioAssets(token);
      if (existing.some((asset) => asset.path === path)) {
        return studioJson({ error: '同名素材已存在，请重命名后上传。' }, 409);
      }
    } catch {
      // 空素材目录在 GitHub 上可能不存在，继续首次写入。
    }
    await writeStudioBinaryFile({
      token,
      path,
      content: buffer,
      message: `Upload studio asset: ${stem}.${extension}`,
    });
    return studioJson({ ok: true, path, reference: `@assets/images/content/${stem}.${extension}` });
  } catch (error) {
    return studioApiError(error);
  }
};

export const DELETE: APIRoute = async ({ cookies, request, url }) => {
  try {
    if (!verifyStudioOrigin(request, url)) return studioJson({ error: '请求来源不合法。' }, 403);
    const token = requireStudioToken(cookies);
    const body = (await request.json()) as { path?: string; sha?: string };
    if (!body.path?.startsWith('src/assets/images/content/') || body.path.includes('..')) {
      return studioJson({ error: '素材路径不合法。' }, 400);
    }
    await deleteStudioFile(body.path, body.sha, token);
    return studioJson({ ok: true });
  } catch (error) {
    return studioApiError(error);
  }
};
