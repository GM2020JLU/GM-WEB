import type { APIRoute } from 'astro';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import {
  diagnoseGitHubMarkdownAccess,
  githubAccessErrorMessage,
} from '../../../utils/github-app-access';
import {
  createGitHubMarkdownFile,
  MarkdownImportConflictError,
  MarkdownImportPermissionError,
} from '../../../utils/markdown-import-github';
import { createImportedMarkdown } from '../../../utils/markdown-import';
import { markdownImportRequestSchema } from '../../../utils/markdown-import-schema';

export const prerender = false;

const requestedStorage = import.meta.env.PUBLIC_KEYSTATIC_STORAGE_KIND;
const isGitHubStorage =
  requestedStorage === 'github' || (requestedStorage !== 'local' && import.meta.env.PROD);

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
    },
  });
}

function githubStatus(error: unknown) {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}

export const POST: APIRoute = async ({ request, cookies, url }) => {
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return json({ error: '请求来源不合法。' }, 403);
  if (import.meta.env.PROD && !origin) return json({ error: '请求缺少来源信息。' }, 403);

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 2_200_000) return json({ error: '导入请求过大。' }, 413);

  let githubToken = '';
  try {
    const payload = markdownImportRequestSchema.parse(await request.json());
    const imported = createImportedMarkdown(payload);

    if (isGitHubStorage) {
      const token = cookies.get('keystatic-gh-access-token')?.value;
      if (!token) {
        return json(
          {
            error: '请先登录 Keystatic 后再导入。',
            loginUrl: '/api/keystatic/github/login?from=branch/main',
          },
          401,
        );
      }
      githubToken = token;
      await createGitHubMarkdownFile({ token, path: imported.path, content: imported.content });
    } else {
      const target = resolve(process.cwd(), imported.path);
      await writeFile(target, imported.content, { encoding: 'utf8', flag: 'wx' });
    }

    return json({
      ok: true,
      collection: payload.collection,
      slug: payload.slug,
      path: imported.path,
      warnings: imported.warnings,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return json({ error: error.issues[0]?.message || '导入字段校验失败。' }, 400);
    }
    if (
      error instanceof MarkdownImportConflictError ||
      (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')
    ) {
      return json({ error: '同名内容已存在，请更换网址别名。' }, 409);
    }
    if (error instanceof MarkdownImportPermissionError) {
      let message = error.message;
      let actionUrl = error.actionUrl;
      if (githubToken) {
        try {
          const diagnosis = await diagnoseGitHubMarkdownAccess({ token: githubToken });
          message = githubAccessErrorMessage(diagnosis);
          actionUrl = diagnosis.installationSettingsUrl || actionUrl;
        } catch {
          // 权限诊断不可用时保留原始、可操作的 GitHub App 安装提示。
        }
      }
      return json(
        {
          error: message,
          actionLabel: error.actionLabel,
          actionUrl,
        },
        403,
      );
    }
    const status = githubStatus(error);
    if (status === 401) return json({ error: 'GitHub 登录已过期，请重新登录。' }, 401);
    if (status === 403) {
      return json(
        {
          error: '当前 GitHub 账号没有仓库写入权限。',
          actionLabel: '配置 GitHub App 仓库权限',
          actionUrl: 'https://github.com/apps/gm2020jlu-keystatic/installations/new',
        },
        403,
      );
    }
    console.error('Markdown import failed', error);
    return json({ error: error instanceof Error ? error.message : 'Markdown 导入失败。' }, 500);
  }
};

export const ALL: APIRoute = () => json({ error: '仅支持 POST 请求。' }, 405);
