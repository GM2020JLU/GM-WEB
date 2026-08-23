# goumin.work

Gou Min 的中文个人站，记录嵌入式系统、Linux BSP、存储驱动、SoC Bring-up 与日常折腾。

站点基于 [Navfolio](https://github.com/dodolalorc/astro-navfolio) 和 Astro 构建，以简体中文为默认语言，通过 Vercel 发布到 [goumin.work](https://goumin.work)。

## 本地开发

需要 Bun、Python 3、FontTools 和 Brotli。

```bash
python3 -m venv .venv
.venv/bin/python -m pip install fonttools brotli
bun install
bun run dev
```

本地地址默认为 `http://localhost:4321`。

## 内容与配置

- `src/config/site.toml`：站点资料、导航、主题和首页文案。
- `src/content/blog/`：长文与技术笔记。
- `src/content/projects/`：项目记录。
- `src/content/vibe/`：短随记。
- `src/content/about.mdx`：关于页。

快速新建内容：

```bash
bun run post:new article-slug
bun run project:new project-slug
bun run vibe:new note-slug
```

## 质量门禁

```bash
bun run check
```

该命令会依次执行 ESLint、Prettier、中文字体子集生成、Astro 生产构建、Pagefind 搜索索引以及产物验证。产物验证覆盖必要路由、中文语言声明、SEO 元数据、RSS、Sitemap、断链、模板残留与核心资源体积预算。

## 部署

Vercel 配置位于 `vercel.json`：

```bash
vercel link --project gm-web --yes
vercel deploy --prod --yes
```

生产部署前必须先通过 `bun run check`。

## 开源说明

本项目在 Navfolio 的 MIT 许可证下进行个人化与中文化。上游版权声明保留在 `LICENSE` 中。
