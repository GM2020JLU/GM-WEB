# 当前进度

最后核对：2026-08-26
证据：当前功能分支、当前 manifests、lockfile、source、deploy workflow 与上层
生态地图。

## 已落地

- Astro 7、Tailwind 4、TypeScript 7 与 Bun 构建工作流。
- `core` 的 i18n runtime 与 theme manifest contracts。
- `theme-default` 的首批 layout/base/blog components、palette/global/blog/layout
  styles，以及主站 compatibility wrappers。
- `pages` protocol、module resolution/validation、官方 factory 导出、scaffold/i18n
  聚合，以及页面包自带 Markdown 模板的标准变量渲染。
- `post:new`、`project:new`、`vibe:new`、`media:new` 统一使用
  `<filename> [output-directory]` 参数；默认 frontmatter 和正文不再硬编码在脚本。
- Projects、Vibe、Media 的 starter 显式注册；Vibe 和 Media 的 package-owned
  routes。
- Markdown preset 对 Expressive Code、callout、columns/timeline、responsive
  tables、Mermaid 和 math 的组合。
- `mdx-components` 的显式内容 components/runtime helpers，包括友链申请表单、
  字段数据复制与 GitHub Issue/Issue Form 预填。
- 首页 dashboard、Blog archive/category/series/tag、搜索、评论、多语言 UI。
- starter 与 docs/demo 双内容模式。
- Friend Circle build-time sync、静态 JSON consumer 和字体子集联动。
- 复用开源 Keystatic 的中文写作后台，已映射 Blog、Projects、Vibe 和
  About 的现有 Markdown/MDX 字段。
- 官方 Keystatic Reader、编辑器语义往返、本地 API 创建/二次保存/删除、
  Astro 内容同步与 Vercel GitHub 模式构建验证。
- 公开页继续静态预渲染，Keystatic/React 资源不会被首页加载；搜索、
  中文化和资源精简产物会同步到 Vercel Build Output。
- 内容后台具备草稿、待发布、已发布三段状态，自动更新时间和东八区发布时间控件。
- 标签、分类、系列改为受控集合；文章封面、随记图片和书影音封面使用媒体字段。
- `/preview/**` 提供基于真实内容与站点样式的响应式、深浅主题预览，包含未发布内容。
- `/studio` 已重新收敛为精简内容工作台：状态/类型筛选、搜索、创建、导入、批量操作、
  编辑/预览和线上入口；移除了营销式欢迎区、教学流程、统计卡片与重复信息。
- Studio 编辑器将标题、摘要和正文作为主流程，网址别名改为根据中英文标题自动生成，
  同名时自动追加序号；日期、分类、系列、兼容字段等低频选项收进“更多设置”。
- 单条和批量发布返回 Git commit SHA；编辑页与工作台跨页面追踪 GitHub/Vercel 部署，
  明确展示“发布已提交 → 等待构建 → 正在构建 → 网站已上线/失败”，上线后提供链接。
- 工作台、新建入口与预览返回编辑会区分本地模式和 GitHub `main` 分支路由；内容队列
  提供可展开的健康度建议和问题筛选，项目案例具备角色、周期、成果与外部证据字段。
- 首页已明确展示嵌入式方向、项目案例与邮件转化入口；项目详情先展示结构化案例概览，
  再进入完整过程正文。
- `/studio/import` 复用 Markdown AST、受限 YAML、Zod、Octokit 与 Keystatic GitHub 登录，
  支持 Blog/Vibe/Media 单文件预览后导入；强制草稿、字段白名单且不覆盖同名内容。
- `/studio` 已成为完整日常后台：Blog、Projects、Vibe、Media、About 与三类 taxonomy
  均可在统一界面新建、源码编辑、安全渲染预览、保存草稿、设为待发布、发布、撤回、
  删除；导入成功不再跳转 Keystatic。
- Studio 已接入素材上传/检索/引用/删除、批量发布状态、定时发布、GitHub 内容历史和
  非破坏性版本恢复；Keystatic 仅作为隐藏应急入口保留。
- 构建前内容审计覆盖必填字段、日期、分类引用、图片文件/替代文本、重复 slug 和占位
  内容；草稿告警，待发布和已发布内容阻止式检查。
- 标准 `check` 已纳入 Astro/TypeScript 全项目检查；`test:full` 覆盖主站与 docs 构建、
  单元测试及隔离的 Keystatic 全内容类型 CRUD、图片、关系与路径安全回归。
- Studio 发布回归新增浏览器 DOM 点击测试，覆盖自动网址、发布提交、构建进度、上线提示
  与待部署记录清理；本地同源 HTTP 回归已验证发布、回读和删除闭环。

## 过渡中

- `core` 的共享契约范围仍小于长期完整 orchestration 目标。
- `theme-default` 只覆盖部分 UI；首页 widgets、Projects、部分 blog/comment/search
  UI 和 wrappers 仍在主站。
- Projects 尚未像 Vibe/Media 一样拥有 package route/UI。
- collection schemas 仍由主站集中定义。
- GitHub dependencies 通过远端 commit 和 lockfile 集成，没有统一的 sibling
  workspace linking。
- deploy 使用 docs submodule `--remote`，但本地可复现仍依赖正确提交 gitlink。
- 线上 Keystatic 若尚未完成授权，仍需要仓库拥有者创建/授权 GitHub App，并将生成的
  4 个环境变量写入 Vercel；密钥不进入仓库。

## 已存在但未接入主站

- `weread-sync` 可输出隐私过滤的版本化阅读快照和可选 sanitized insights；主站没有
  consumer。
- `page-template` 是第三方 page module 参考，不是主站运行时依赖。

## 不是当前组件

旧提案中的 `@navfolio/types`、`@navfolio/utils`、
`@navfolio/plugin-blog`、`create-navfolio` 和“完整 orchestration core”都不能当作
已落地 package。只有 manifest、源码、consumer 与 lockfile 有证据时才更新状态。

## 状态维护

- 合并 package 代码不等于完成集成；还需确认 downstream pin、lockfile、docs 和
  build。
- package 存在不等于完成长期目标；只记录当前 exports 和 consumer。
- 下一阶段工作由 issue/PR/用户任务定义，不在本文件维护建议 backlog。
