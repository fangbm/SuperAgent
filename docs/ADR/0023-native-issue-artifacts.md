# ADR 0023：GitHub Issue 原生附件与增量报告

2026-11-05。PR C 依赖 A/B。用户明确要求图片/文件直接附到 Issue，因此不使用 Contents API、证据仓库、Release 或公开图床。

## 发布方式

GitHub 当前官方 CLI 已支持 --attach，官方实现将原文件字节 POST 到 uploads.github.com/user-attachments/assets，参数为 repository_id/name/content_type；随后将返回的 github.com/user-attachments 永久引用写入正文。依据 [官方说明](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli) 与 [官方实现固定版本](https://github.com/cli/cli/blob/eeb44bc432c0107de002dadd34a61b4e2bd15882/internal/attachments/client.go)。这不是 Create Issue REST 的文件参数，也不使用浏览器 Cookie/抓取登录状态；不要求升级本机 gh。

GitHubIssueAssets 使用该协议。每次发布前核对目标仓库私有性、数值 ID 及写权限；有些 GitHub App 凭据才支持上传端点，普通 PAT 不保证可用。图片使用实际 MIME，日志作为 text/plain 原字节及匿名 txt 文件名提交。官方 CLI 当前只列图片/媒体，文本文件接收须真实账号验收；本轮只验证受控请求和拒绝处理，不将其写成服务端已接受的事实。

只有 exact primary 事件的已保存、当前可见文件可发布，target 就是该工作项的配置 Issue 仓库，不借用其他项目或仓库缓存。读取本地文件时再次授权/核验 SHA-256；文件成功上传后还必须授权下载得到同哈希、匿名访问被拒绝，才进入 published 并出现在报告。下载的批准 CDN 重定向不携带 Bearer 凭据；未知域名拒绝。稳定引用无 token/query/hash，不把短期签名 URL 写入报告。

## 持久化与未知结果

沿用现有 Issue/专用评论的 GitHubSyncManager 和外部操作账本。原表的 CHECK 不允许附件上传这种 kind，不能伪装成 Issue PATCH 或修改冻结迁移，所以附件使用同库独立 artifact_publications outbox；通过 github_output_feature_migrations 哈希账本安装，不新建数据库/进程/通用投递框架。

上传前先认领持久租约、记录尝试；单仓库串行，实际上传至少间隔 15 秒。429 等明确拒绝才最多三次重试，等待至少 60 秒及更长的 Retry-After。网络中断、5xx 或已成功但 URL 本地确认失败都保持 unknown，不重复 POST。原生端点没有可用的相关标记枚举对账，因此无 URL 的 unknown 留给人工复核，不能凭“查不到”认定未上传。已持久化 URL 的恢复只读验证，不重新上传；验证有次数、时间和关闭边界。

## 内容更新与人工编辑

WorkReportBuilder 使用可信附件状态解析器，仍与 GitHub 无依赖。事件/assetRef 身份不可被解析器替换。捕获完成/过期和发布状态变化，将相关 active primary 工作项的报告修订号推进，唤醒原有 github_sync_outbox。报告内容哈希作为更新幂等键，已同步同哈希只确认修订，不重复评论。

每个原有外部操作记录其报告修订；确认写入时比较最新修订，避免上传完成发生在 Issue/评论请求途中却被 desired_version 相同覆盖。新建 Issue 包含当时已发布的附件；迟到附件更新机器人拥有的专用评论。Issue 正文不 PATCH，人工改机器人评论后进入复核并保留 held，不自动恢复覆盖。

玩家文件仍是不可信证据，不运行脚本、不做图片视觉分析、不因附件已发布就认定其业务含义已核实。来源删除会撤销本地读取/后续发布，不承诺删除已由 GitHub 保存的历史附件或人工正文；留存治理另行设计。

## 2026-11-05 后续实测与默认值

用户要求测试后默认开启。附件子能力默认开启/继承既有 GitHub 写入授权，平台父开关不自动启用，显式 false 继续有效。全部相关父服务关闭时不实例化存储或索取闲置密钥，使用时仍要求稳定密钥，禁止静默随机替换。默认值及关闭回归见 artifact-defaults.test.mjs，未更改 M0 冻结默认策略。

真实上传已证实本机 gh 凭据可发送 PNG，授权读取同哈希且匿名稳定地址 404；不再将上传凭据描述为必须是 GitHub App。GitHub 实际授权重定向到精确 S3 主机 github-production-user-asset-6210df.s3.amazonaws.com；仅补入该固定主机，禁止泛化到 *.amazonaws.com，不转发 Bearer，不保存签名 URL。纯文本上传 HTTP 422，日志直传未通过；保留本地读取及失败状态。详细证据与本机代理边界见 GITHUB-ISSUE-ASSETS.md。
