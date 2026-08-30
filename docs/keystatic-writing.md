# Studio 中文内容后台

本站的日常后台位于 `/studio`，复用 unified、YAML、Zod、Octokit、Sharp 和
Keystatic GitHub OAuth 等开源能力；公开页面仍由 Astro 预渲染为静态 HTML。
`/keystatic` 不再出现在正常工作流中，只作为字段兼容和故障恢复的应急入口。

## 本地写作

```bash
bun run dev
```

打开 `http://127.0.0.1:4321/studio`。本地模式直接写入 `src/content`，不需要
GitHub 登录。

## 线上写作

正式入口是 `https://studio.goumin.work/`，由 Mac 上的 Astro 服务以本地存储模式运行。
Caddy 会先向仅监听回环地址的认证服务校验签名会话，通过后才允许请求进入 Astro/Vite；
因此未登录状态无法接触工作台、写入 API 或开发服务资源。

登录页默认使用 GitHub 验证，只接受 allowlist 中的数字 GitHub User ID，不依赖可改名的
login 名。授权流程使用签名 `state` 和 PKCE S256，回调地址必须精确登记为
`https://studio.goumin.work/api/studio/auth/github/callback`。认证服务只用临时 GitHub token
读取 `/user` 的不变 ID，验证后必须撤销 token 才会签发会话，不写入 Cookie、日志
或磁盘。OAuth 入口同时有 IP 窗口限速和外部交换并发上限。

公网登录页只提供 GitHub 验证，`/api/studio/session` 密码提交路径不会在公网主机名
路由。用户名 `goumin` 和强随机密码仅用于 Mac 回环地址上的应急恢复，密码只保存在
Mac 用户专属的 `0600` 凭据文件。需要恢复时，先建立 SSH 端口转发：

```bash
ssh -L 8081:127.0.0.1:8081 mac
```

然后在本机浏览器打开 `http://localhost:8081/studio/login`，页面才会显示密码恢复表单。
GitHub 认证成功后会写入 `HttpOnly + Secure + SameSite=Lax` 的 12 小时签名 Cookie；
回环恢复使用独立的 `HttpOnly + SameSite=Strict` Cookie，公网验证器不读取它。非安全方法仍必须
通过精确同源校验。签名密钥独立保存在 `~/.config/goumin-work/studio-auth-session-secret`，
同样必须为 `0600`。GitHub client ID 与 secret 分别从
`studio-github-client-id` 和 `studio-github-client-secret` 这两个 `0600` 凭据文件读取。
密码登录连续失败会触发限速，退出按钮会立即清除当前浏览器的会话与 OAuth 事务 Cookie。Cloudflare Access 仍可作为额外的上层身份边界；
即使它尚未配置或误配置，Caddy 的前置校验也不会让本地写入 API 直接暴露。Mac 本机仍可
通过上述 `localhost:8081` 的受保护入口恢复访问。

认证后，工作台提供内容新建、Markdown 导入、编辑、真实预览、素材、分类、批量操作、
版本历史与发布状态。保存会写入 Mac 工作副本，本地发布流程完成校验、提交和推送后，由
Vercel 的 Git 集成部署公开站。

需要切换到 GitHub 存储模式时，首次在本地以 GitHub 模式启动，然后在 `/keystatic`
按官方引导创建 GitHub App：

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

GitHub 模式下，只有对 `GM2020JLU/GM-WEB` 有写权限的 GitHub 用户才能登录和保存。
保存会更新仓库中的 Markdown/MDX 文件，并触发 Vercel 自动部署。

## 推荐发布流程

每条内容有三个状态：

1. **草稿**：可以不完整，不会进入公开页面；构建检查只给提醒。
2. **待发布**：进入严格检查，但暂不公开。先用编辑页右上角的“预览”检查桌面、平板、
   手机和深浅主题。
3. **已发布**：通过检查后进入公开页面，保存到 GitHub 会触发 Vercel 部署。

`/studio` 会把 Blog、Projects、Vibe、Media 和 About 汇总在一起，支持关键词、状态与
内容类型的组合筛选，并显示更新时间、字数、预计阅读时间和分类。它还会比较当前
Vercel 构建提交与 GitHub `main` 最新提交；两者一致时显示“最新版本已上线”。

Studio 编辑器提供源码、分栏和渲染预览视图，支持 `Ctrl/Cmd+S` 保存草稿，并每两秒把
未提交修改保存到浏览器恢复区。新内容先进入草稿；正文完成后可以设为待发布、直接发布、
撤回发布，或填写时间后定时发布。仓库里的 Markdown/MDX 格式与目录保持不变。

批量选择可以统一调整多条内容的状态。GitHub 模式下每次保存都会形成版本记录，历史面板
可以查看最近 30 次修改并非破坏性恢复旧版本。定时任务每 15 分钟检查一次
`ready + scheduledAt` 内容，到期后自动发布并触发 Vercel。

## Markdown 导入

`/studio/import` 可导入单个 `.md` 文件，当前支持 Blog、Vibe 和 Media。项目与
关于页使用 `.mdx`，不在第一版导入范围内。流程为：选择文件、解析 YAML
frontmatter 与正文、校对类型/标题/slug，再创建草稿并进入 Studio 编辑器。

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

Studio 编辑地址统一为 `/studio/edit/{collection}/{slug}`，不再区分本地和 GitHub 分支。
工作台、新建入口、Markdown 导入和预览页的“返回编辑”都使用该地址。

工作台的“建议完善”会检查标题、摘要、正文、更新时间、分类、图片替代文本，以及项目
案例的角色、成果和外部链接。点击健康度标签可看到具体下一步；这些建议帮助草稿逐步
完整，待发布和已发布内容仍以构建门禁结果为准。

## 图片与分类

- 素材库支持 JPG、PNG、WebP、GIF 和 AVIF 的上传、检索、引用复制和删除，文件统一保存到
  `src/assets/images/content`；服务端使用 Sharp 校验真实图片格式，单文件最大 5 MB。
- 封面包含有效信息时填写“封面图替代文本”；发布检查也会检查 Markdown 图片的 alt。
- 标签、分类和系列先在“内容组织”中建立，再在文章中填写，避免同义词和错别字形成
  重复入口。
- 每次后台保存会自动刷新 `updatedDate`；发布时间使用可视化日期时间控件，并统一保存
  为 `+08:00`。

## 内容兼容边界

- 博客和随记继续使用 `.md`，项目和关于页继续使用 `.mdx`，没有切换解析器。
- 保留 UTF-8、完整 ISO 8601 时区、远程图片 URL 和 Astro 本地资源路径。
- Studio 采用源码优先编辑，渲染预览复用 unified 和 rehype-sanitize，不会在保存时改写
  正文 Markdown 风格。
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
