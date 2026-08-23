# Keystatic 中文写作后台

本站不自建 CMS。写作后台复用 Keystatic 的开源编辑器、官方 Astro 集成和
GitHub 存储模式；公开页面仍由 Astro 预渲染为静态 HTML。

## 本地写作

```bash
bun run dev
```

打开 `http://127.0.0.1:4321/keystatic`。本地模式直接写入 `src/content`，不需要
GitHub 登录。

## 线上写作

生产环境使用 GitHub 模式。首次需要在本地以 GitHub 模式启动，然后在
`/keystatic` 按官方引导创建 GitHub App：

```bash
PUBLIC_KEYSTATIC_STORAGE_KIND=github bun run dev
```

在创建表单的 **Deployed site URL** 中填写 `https://goumin.work`，确保 GitHub App
包含正式站回调：
`https://goumin.work/api/keystatic/github/oauth/callback`。如果 App 已经创建，可在
GitHub App 设置的 **Callback URL** 列表中补充该地址。

引导会生成下列环境变量，它们只能写入本地 `.env` 和 Vercel，不得提交到
Git：

- `KEYSTATIC_GITHUB_CLIENT_ID`
- `KEYSTATIC_GITHUB_CLIENT_SECRET`
- `KEYSTATIC_SECRET`
- `PUBLIC_KEYSTATIC_GITHUB_APP_SLUG`

配置完成后，打开 `https://goumin.work/keystatic`。只有对
`GM2020JLU/GM-WEB` 有写权限的 GitHub 用户才能登录和保存。保存会更新 GitHub
中的 Markdown/MDX 文件；Vercel 连接该仓库后会自动重新部署。

## 内容兼容边界

- 博客和随记继续使用 `.md`，项目和关于页继续使用 `.mdx`，没有切换解析器。
- 保留 UTF-8、完整 ISO 8601 时区、远程图片 URL 和 Astro 本地资源路径。
- 富文本保存时可能统一 Markdown 源码风格（例如把列表符号 `-` 改成 `*`），
  但回归测试会阻止标题、段落、列表、链接或代码块结构发生变化。
- Keystatic MDX 不支持文章内的 `import`/`export` 和原始 HTML/JSX 标签。构建前兼容
  测试会在遇到这些语法时立即报错，避免不可逆改写。
- Navfolio 的 `sticky` 同时支持布尔值和排序数字，Keystatic 没有同构字段。后台会
  原样保留该值，但不提供编辑控件。

## 发布前门禁

`bun run build` 会先执行 Keystatic 兼容测试，再构建站点。它会检查所有现有内容
可被官方 Reader 读取、UTF-8 无乱码，以及正文经官方编辑器往返后 Markdown
语义树一致。
