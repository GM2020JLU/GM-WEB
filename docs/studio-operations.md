# Studio 运维手册

本手册记录 `studio.goumin.work` 的发布、定时任务、备份、OAuth 和故障恢复边界。本地生产仓库位于 Mac 的 `/Users/goumin/Services/goumin-work/repo`，运行数据位于 `/Users/goumin/Services/goumin-work/runtime`。从其他受信主机检查时始终使用 SSH 别名 `mac`，不要把地址硬编码到脚本或文档。

## 发布语义

- “保存”和 `Ctrl/Cmd+S` 保持服务器当前的 `draft` / `ready` / `published` 状态。
- 只有显式“撤回发布”才会把已发布内容改回草稿。
- 草稿和待发布内容的普通保存不入发布队列。已发布内容的修改、显式发布/撤回、删除公开内容以及会影响公开页面的分类信息变更会入队。
- “内容已保存”不等于“网站已上线”。只有生产域名回报同一 Git SHA 才能将任务标记为 `ready`。

## Mac launchd 服务

三个 plist 都位于 `deploy/macos/`：

| Label                                     | 作用                                       | 启动方式                                |
| ----------------------------------------- | ------------------------------------------ | --------------------------------------- |
| `com.goumin.goumin-work.studio-worker`    | 消费持久发布队列，构建、推送并等待生产 SHA | `RunAtLoad + KeepAlive`                 |
| `com.goumin.goumin-work.studio-scheduler` | 检查本地 `ready + scheduledAt` 内容并入队  | `RunAtLoad`，每 300 秒                  |
| `com.goumin.goumin-work.studio-backup`    | 同步本地备份与待同步快照                   | `RunAtLoad + WatchPaths`，至少每 300 秒 |

worker 和定时器使用带心跳的运行时租约防止多实例。worker 每 2 秒读取队列，租约超过 90 秒无心跳才视为失效；单次构建最长 15 分钟，推送后最多等待 12 分钟生产 marker。worker 中断后重启会把 `deployment-queue/processing` 中的完整任务放回队列，不依赖发起 API 请求的进程存活。日志写入 `~/Library/Logs/goumin-work/`。

巡检时可在 Mac 上执行：

```bash
launchctl print gui/$(id -u)/com.goumin.goumin-work.studio-worker
launchctl print gui/$(id -u)/com.goumin.goumin-work.studio-scheduler
launchctl print gui/$(id -u)/com.goumin.goumin-work.studio-backup
```

不要同时开启 GitHub 定时写入。`.github/workflows/publish-scheduled.yml` 只有手动 `workflow_dispatch`，用于 Mac 长时间无法恢复时的灾备；手动启用前先确认 Mac scheduler 已停止，且所需定时内容确实已在 GitHub `main`。

## 不可变快照与生产 SHA

发布 worker 的处理顺序是：

1. 获取 `origin/main`，确认它是 Mac `HEAD` 的祖先；如果 GitHub 已领先则停止，避免覆盖远端变更。
2. 获取内容文件锁，拒绝使用已被其他操作污染的暂存区，只暂存 Studio 管理的内容、站点配置和内容图片。
3. 必要时创建一个 Git 提交，记录精确的 40 位 `snapshotSha`。
4. 从该 SHA 创建 detached worktree，在其中运行生产构建与 `verify:build`。构建期间的后续编辑不会混入这次产物。
5. 推送精确的 `snapshotSha` 到 `main`，并把 Mac 预览原子切换到该静态版本；本地最近保留 5 个 release。
6. 轮询 `https://goumin.work/.well-known/navfolio-build.json`。只有其 `sha` 等于 `snapshotSha` 才报告“网站已上线”；超时或不一致都记录为失败。

`bun run build` 在构建开始时写入 `/.well-known/navfolio-build.json`。Vercel 使用 `VERCEL_GIT_COMMIT_SHA`，Mac worker 使用显式的 `NAVFOLIO_BUILD_SHA`；marker 响应禁止 CDN 缓存，避免旧版 SHA 造成假成功。

## 本地与离机备份

本地写入在替换或删除旧内容前生成版本备份，并在成功写入内容或图片后生成离机待同步快照：

- 版本备份：`$STUDIO_RUNTIME_DIR/backups/*.json`。
- 待同步快照：`$STUDIO_RUNTIME_DIR/offsite-pending/*.json`。
- 运行目录权限为 `0700`，JSON 文件权限为 `0600`；文本以 UTF-8 保存，二进制素材使用 base64。
- 本地版本每个内容路径最多保留 30 份，最长 120 天，任一条件超限就删除。
- launchd 备份任务把 `backups` 与 `offsite-pending` 同步到 `STUDIO_OFFSITE_BACKUP_DIR`。当前 plist 将它设为私有 iCloud Drive 目录 `~/Library/Mobile Documents/com~apple~CloudDocs/Goumin Studio Backups`。
- 删除操作会生成 tombstone，防止全量恢复时误把已删除项目当作当前内容；`offsite-pending` 文件只在成功复制后删除。
- 离机目录权限为 `0700`，备份文件权限为 `0600`；全局最多保留 500 份且最长 365 天。

备份 JSON 可能包含尚未公开的草稿和图片，iCloud Drive 目录不得设为共享，不得把备份发送到公开工单或提交到 Git。

### 恢复顺序

1. **浏览器未提交编辑**：重新打开同一编辑地址，根据提示恢复。如果服务器 SHA 已变化，先阅读警告再确认；恢复过程保留服务器的最新发布状态。
2. **已覆盖的文本内容**：在编辑器打开“版本历史”，先用“查看差异”确认版本，再点击“恢复此版本”。恢复前的当前版本仍会被保留。
3. **整体离机恢复**：先停止进一步编辑，再把 iCloud 备份恢复到一个不存在或为空的隔离目录：

   ```bash
   bun run studio:backup:restore -- \
     "/Users/goumin/Library/Mobile Documents/com~apple~CloudDocs/Goumin Studio Backups" \
     "/Users/goumin/Services/goumin-work/recovery"
   ```

   恢复工具按受管路径选择最新快照，拒绝路径穿越、源/目标嵌套和覆盖非空目录，并跳过最新记录为 tombstone 的路径。不要把恢复目录直接指向生产仓库；先检查、运行内容验证并对比差异，再在维护窗口中将所需文件安全合并回工作副本。

4. **特意恢复已删除项目**：在私有临时备份目录中只放入目标路径的指定删除前快照，不包含后续 tombstone，再用上述命令恢复到另一个空目录。检查 `path`、`encoding`、SHA 和内容后，通过维护流程恢复并运行 `bun run verify:content`。

## GitHub OAuth

在 GitHub App 设置页 **Identifying and authorizing users** 下的 **Redirect URI** 列表中添加：

```text
https://studio.goumin.work/api/studio/auth/github/callback
```

要求：

- 不开启通配符，不把 Homepage URL 或 Setup URL 当成回调地址。
- 精确保留 `https`、`studio.goumin.work`、完整路径且不追加末尾斜杠。
- 生产登录验证后删除不再使用的 HTTP、局域网和错误端口 Redirect URI。
- 客户端 ID、客户端 secret 和会话签名密钥只保存在 Mac 的 `0600` 凭据文件。文档、日志、Git 和截图中都不得出现完整凭据。

如果明确启用 `/keystatic` 应急存储，可在列表中另外添加精确的 `https://goumin.work/api/keystatic/github/oauth/callback`，但它不能代替 Studio Redirect URI。

## Vercel 公开产物边界

Astro 仍会为 Mac 生成 Studio 与预览路由，但 Vercel 的最终 Build Output 会经过独立裁剪：

- 从静态目录移除 `studio`、`preview`、`keystatic` 和 `api`。
- 移除 Vercel server functions，公网站不承载写入 API。
- 从 `/_astro` 移除没有任何公开页面引用的 Studio/Keystatic bundle。
- 为后台、预览和 API 路径加入统一 404 拒绝路由；`/studio` 的 Vercel 入口仅负责跳转到独立的 `studio.goumin.work`。

每次发布前使用以下命令完成本地门禁：

```bash
bun run test:full
```

`verify:build` 会确认公开 Sitemap/Pagefind 只包含公开路由，且 Vercel 产物不包含后台路由、API 函数或后台 bundle。生产后再检查 marker：

```bash
curl -fsS https://goumin.work/.well-known/navfolio-build.json
```

返回的 `sha` 必须与预期的已验证提交一致；不一致时不要把发布标记为完成。
