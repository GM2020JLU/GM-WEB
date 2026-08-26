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

配置完成后，先打开 `https://goumin.work/studio`。工作台首页提供四类内容的“新建”和 Markdown 导入
快捷入口、草稿/待发布提醒、发布流程、搜索和筛选；需要管理全部内容或分类时，再进入
`https://goumin.work/keystatic`。只有对
`GM2020JLU/GM-WEB` 有写权限的 GitHub 用户才能登录和保存。保存会更新 GitHub
中的 Markdown/MDX 文件；Vercel 连接该仓库后会自动重新部署。

## 推荐发布流程

每条内容有三个状态：

1. **草稿**：可以不完整，不会进入公开页面；构建检查只给提醒。
2. **待发布**：进入严格检查，但暂不公开。先用编辑页右上角的“预览”检查桌面、平板、
   手机和深浅主题。
3. **已发布**：通过检查后进入公开页面，保存到 GitHub 会触发 Vercel 部署。

`/studio` 会把 Blog、Projects、Vibe、Media 和 About 汇总在一起，支持关键词、状态与
内容类型的组合筛选，并显示更新时间、字数、预计阅读时间和分类。它还会比较当前
Vercel 构建提交与 GitHub `main` 最新提交；两者一致时显示“最新版本已上线”。

Keystatic 内部按“创作与发布 / 站点页面 / 内容组织”分组。新内容先进入草稿；正文完成
后切换为待发布并打开预览，检查无误再切换为已发布。工作台和编辑器都使用中文名称，
但仓库里的文件格式与目录保持不变。

## Markdown 导入

`/studio/import` 可导入单个 `.md` 文件，当前支持 Blog、Vibe 和 Media。项目与
关于页使用 `.mdx`，不在第一版导入范围内。流程为：选择文件、解析 YAML
frontmatter 与正文、校对类型/标题/slug，再创建草稿并进入 Keystatic 编辑器。

- 语法识别复用 unified 生态的 `mdast-util-from-markdown` 和
  `mdast-util-frontmatter`；YAML 使用 `yaml` 并禁止别名，不使用正则手写 frontmatter
  切割。
- 服务端会重新解析和 Zod 校验，只保留本站 schema 认识的字段；来源文件的
  `publicationStatus`、`draft` 和 `updatedDate` 会被安全的草稿值替换。
- 线上写入复用 Keystatic 的 GitHub OAuth cookie，并通过 Octokit 调用 GitHub
  Contents API；同名 slug 在预检查或并发写入时都会被拒绝，不会覆盖。
- 单文件最大 1 MB，只接受 `.md`；渲染预览复用 unified、remark-gfm 和
  rehype-sanitize，危险 URL、HTML 与脚本不会进入预览 DOM。
- 如果 GitHub 返回 403，导入页会提供 GitHub App 配置入口。确认
  `gm2020jlu-keystatic` 已安装到账号并选择 `GM-WEB` 仓库；App 本身和当前登录用户都必须
  具备 Contents 写权限。

线上编辑地址会自动带上 GitHub 分支，例如
`/keystatic/branch/main/collection/blog/item/example`；本地编辑地址不带分支。不要手工拼接
编辑链接，工作台、新建入口和预览页的“返回编辑”会根据运行环境生成正确地址。

工作台的“建议完善”会检查标题、摘要、正文、更新时间、分类、图片替代文本，以及项目
案例的角色、成果和外部链接。点击健康度标签可看到具体下一步；这些建议帮助草稿逐步
完整，待发布和已发布内容仍以构建门禁结果为准。

## 图片与分类

- 封面、随记图片和书影音封面都使用后台图片选择器，文件统一保存到
  `src/assets/images/content`。
- 封面包含有效信息时填写“封面图替代文本”；发布检查也会检查 Markdown 图片的 alt。
- 标签、分类和系列先在“分类管理”中建立，再在文章中选择，避免同义词和错别字形成
  重复入口。
- 每次后台保存会自动刷新 `updatedDate`；发布时间使用可视化日期时间控件，并统一保存
  为 `+08:00`。

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

`bun run build` 会依次执行内容发布审计和 Keystatic 兼容测试，再构建站点。

- `bun run verify:content`：检查发布状态、必填字段、日期、自动更新时间、重复网址别名、
  分类引用、图片文件、图片替代文本和测试占位内容。待发布/已发布内容有错误时阻止构建；
  草稿只提醒。
- `bun run verify:keystatic`：检查所有现有内容可被官方 Reader 读取、UTF-8 无乱码、
  日期与自动字段序列化、预览和列表配置，以及正文经官方编辑器往返后 Markdown 语义树
  一致。
- `bun test`：运行发布规则与站点工具的单元测试。
- `bun run test:keystatic-crud`：在独立临时目录中创建、读取、二次保存和删除所有内容
  类型，同时检查图片、分类关系、目录树、跨域头与路径穿越保护，不修改真实文章。
- `bun run test:full`：一次执行格式与静态检查、TypeScript/Astro 检查、主站构建、构建
  产物验证、全部单元测试、Keystatic CRUD 回归及 docs 内容构建；发布前以它为准。

预览和工作台会同时通过 HTML、`robots.txt` 与 Vercel 响应头禁止索引和缓存；后台
密钥只存在于环境变量中，不会进入静态页面。
