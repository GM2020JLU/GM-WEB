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
- `docs/keystatic-writing.md`：Studio 写作与发布指南。
- `docs/studio-operations.md`：Mac 发布、备份、OAuth 与故障恢复手册。

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

该命令会依次执行 ESLint、Prettier、中文字体子集生成、Astro 生产构建、Pagefind 搜索索引以及产物验证。产物验证覆盖公开路由白名单、标题层级、中文语言声明、SEO 元数据、RSS、Sitemap、Pagefind、断链、模板残留、后台资源隔离与核心资源体积预算。

## Studio 与发布架构

日常写作使用 `https://studio.goumin.work/`，内容保存在 Mac 的工作副本。普通“保存”和 `Ctrl/Cmd+S` 保持当前的草稿、待发布或已发布状态；撤回上线必须显式选择“撤回发布”。草稿和待发布内容的普通保存不会发起 Vercel 构建；已发布内容的更新、显式发布/撤回以及会影响公开页面的组织信息变更才会进入发布队列。

Mac 上的 launchd 单例 worker 会为一批请求生成精确 Git 提交，在 detached worktree 中构建这个不可变快照，验证后推送同一 SHA。Vercel 的 Git 集成随后发布公共静态产物；Studio、Keystatic、预览路由、API、服务端函数与不可达后台 bundle 会从 Vercel 产物中移除。worker 只在生产域名的 `/.well-known/navfolio-build.json` 返回同一 SHA 后才标记“已上线”。

定时发布与私有备份同样由 Mac launchd 负责。定时器每 5 分钟检查本地 `ready + scheduledAt` 内容；草稿的本地版本和当前快照以 `0600` 文件保留，并同步到未公开共享的私有 iCloud Drive 目录。具体保留期、恢复和巡检方法见 [Studio 运维手册](docs/studio-operations.md)。

## 部署

Vercel 配置位于 `vercel.json`，项目已连接 GitHub 仓库，`main` 是生产分支。手动修改代码时先通过门禁，再推送同一个已验证提交：

```bash
bun run check
git push origin main
```

Vercel CLI 用于首次 `vercel link --project gm-web --yes` 和部署状态诊断；不要在 Git push
之外再执行 `vercel deploy --prod`，避免同一版本产生两次生产部署。

## 开源说明

本项目在 Navfolio 的 MIT 许可证下进行个人化与中文化。上游版权声明保留在 `LICENSE` 中。
