import type { APIRoute } from 'astro';
import { parse, stringify } from 'smol-toml';
import { z, ZodError } from 'zod';
import {
  requireStudioToken,
  studioApiError,
  studioDeploymentMetadata,
  studioJson,
  studioUsesLocalDeployment,
  verifyStudioOrigin,
} from '../../../utils/studio-api';
import { readStudioFile, writeStudioFile } from '../../../utils/studio-storage';

export const prerender = false;
const path = 'src/config/site.toml';
const schema = z.object({
  expectedSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i, '站点设置版本标识不合法。'),
  site: z.object({
    title: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(240),
    pageTitle: z.string().trim().min(1).max(120),
    pageDescription: z.string().trim().min(1).max(240),
    footerNote: z.string().trim().max(160),
  }),
  theme: z.object({
    palette: z.enum([
      'green-soft',
      'green-vivid',
      'rose-soft',
      'pink-soft',
      'purple-soft',
      'blue-soft',
      'orange-soft',
      'brown-soft',
    ]),
  }),
  profile: z.object({
    name: z.string().trim().min(1).max(80),
    role: z.string().trim().max(120),
    email: z.email(),
    avatar: z.url(),
  }),
  home: z.object({
    introTitle: z.string().trim().min(1).max(40),
    introName: z.string().trim().min(1).max(80),
    introBody: z.string().trim().min(1).max(4000),
    focus: z.string().trim().max(500),
    quote: z.string().trim().min(1).max(1000),
  }),
  pages: z.object({
    blog: z.object({ title: z.string().trim().min(1), subtitle: z.string(), note: z.string() }),
    projects: z.object({ title: z.string().trim().min(1), subtitle: z.string(), note: z.string() }),
    vibe: z.object({ title: z.string().trim().min(1), subtitle: z.string(), note: z.string() }),
    media: z.object({ title: z.string().trim().min(1), subtitle: z.string(), note: z.string() }),
  }),
});

function editable(config: any) {
  return {
    site: {
      title: config.site.title,
      description: config.site.description,
      pageTitle: config.site.pageTitle,
      pageDescription: config.site.pageDescription,
      footerNote: config.site.footerNote,
    },
    theme: { palette: config.theme.palette },
    profile: {
      name: config.profile.name,
      role: config.profile.role,
      email: config.profile.email,
      avatar: config.profile.avatar,
    },
    home: {
      introTitle: config.home.intro.title,
      introName: config.home.intro.name,
      introBody: config.home.intro.body.join('\n'),
      focus: config.home.intro.focus.join('、'),
      quote: config.home.quote.text.join('\n'),
    },
    pages: Object.fromEntries(
      ['blog', 'projects', 'vibe', 'media'].map((key) => [
        key,
        {
          title: config.pages[key].title,
          subtitle: config.pages[key].subtitle,
          note: config.pages[key].note,
        },
      ]),
    ),
  };
}

export const GET: APIRoute = async ({ cookies }) => {
  try {
    const token = requireStudioToken(cookies);
    const file = await readStudioFile(path, token);
    const root = parse(file.content) as any;
    return studioJson({ settings: editable(root.config), sha: file.sha });
  } catch (error) {
    return studioApiError(error);
  }
};

export const PUT: APIRoute = async ({ cookies, request, url }) => {
  try {
    if (!verifyStudioOrigin(request, url)) return studioJson({ error: '请求来源不合法。' }, 403);
    const token = requireStudioToken(cookies);
    const next = schema.parse(await request.json());
    const file = await readStudioFile(path, token);
    const root = parse(file.content) as any;
    Object.assign(root.config.site, next.site);
    Object.assign(root.config.theme, next.theme);
    Object.assign(root.config.profile, next.profile);
    root.config.home.intro.title = next.home.introTitle;
    root.config.home.intro.name = next.home.introName;
    root.config.home.intro.body = next.home.introBody
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    root.config.home.intro.focus = next.home.focus
      .split(/[、,，\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
    root.config.home.quote.text = next.home.quote
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const key of ['blog', 'projects', 'vibe', 'media'] as const) {
      Object.assign(root.config.pages[key], next.pages[key]);
    }
    const written = await writeStudioFile({
      token,
      path,
      expectedSha: next.expectedSha,
      content: stringify(root),
      message: 'Update site settings',
      deployment: studioUsesLocalDeployment
        ? { deploy: true, reason: 'Update site settings' }
        : undefined,
    });
    const deployment = await studioDeploymentMetadata({
      token,
      commitSha: written.commitSha,
      deploy: true,
      localDeploymentId: written.localDeploymentId,
      reason: 'Update site settings',
    });
    return studioJson({
      ok: true,
      sha: written.contentSha,
      ...deployment,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return studioJson({ error: error.issues[0]?.message ?? '站点设置校验失败。' }, 400);
    }
    return studioApiError(error);
  }
};
