# SuperAgent 统一主程序

正式命令：

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm start --config config/superagent.json
```

首次使用先构建，之后正常业务只启动一个进程，不另开 worker:m1、worker:m3、source:m4 或 start:m5。CLI 默认配置路径也是 `config/superagent.json`，因此直接 `pnpm start` 等价。安装、构建是准备步骤，不是需要维持运行的附加程序。

## 配置与授权

`config/superagent.json` 是唯一应用配置，所有相对路径按该文件所在目录解析。`config/plugins/*.json` 仅包含平台连接信息。主配置管理数据库、projectId、实例启停、Manifest 权限授权、凭据引用、模型调用、GitHub、报告、通知、Web 和恢复参数。

默认配置使用 `.artifacts/superagent/state.sqlite`，运行 M1 与固定窗口 M5；所有平台实例、模型和外部写入均关闭。日志明确输出 analysis=disabled，triage pending 不等于模型已分析。正式处理反馈应显式启用模型：

```json
{
  "enabled": true,
  "allowExternalCalls": true,
  "baseURL": "https://your-model-provider.example/v1",
  "model": "your-model",
  "apiKeyEnv": "SA_LLM_API_KEY",
  "timeoutMs": 30000,
  "maxCalls": 12
}
```

上述是 `analysis` 字段示例，域名和模型名必须替换为实际授权接口；密钥只放环境变量，不放 JSON。`github` 使用 `enabled`、`allowWrites`、`repository` 与 `tokenEnv`，写入前复用既有私有仓库检查。仅设置 SA_LLM_* 或 SA_GITHUB_* 环境变量不会开启服务。

Source 在主配置中设置 `enabled:true` 后自动运行。其 `permissions.networkHosts/secretKeys` 必须与 Manifest 一致；`secrets` 将声明键映射到环境变量名。QQ 可改用显式 `protectedConfig`，并清空相应 `secrets` 映射以选用既有 DPAPI 文件。真实用户群与验收群文件必须由操作员明确选择，不自动混用或自动发现旧凭据。QQ WebSocket 无需回调地址；选择 webhook 时还必须在实例配置 `port`，应用监听本机 `/qq/events`。

Discord 需提供真实 guild/channel/thread ID 与 Bot Token，仍保留 #2 已声明的权限及历史覆盖限制。Steam Reviews 使用 #1 官方负评连接器，不恢复 #4 的全评价/评论扩展。Steam Discussions 默认 unavailable；只有显式配置 `mode:"snapshot"` 与合法 `snapshotPath` 时执行本地快照采集，路径相对平台配置文件解析，不代表远端采集。

Delivery 目前为既有 QQ 开发者 C2C 绑定，`enabled:true` 自动加载并 probe，`allowWrites:true` 才能实际发送。非破坏性 probe 不能证明主动发送权限，状态保留 unverified。报告正文、收件人、发送时间、持久意图和 unknown 屏障由既有 Core/Host 决定，插件只执行发送。当前支持一个 projectId 和一个批准开发者 Delivery 绑定，重复绑定会拒绝启动，不会暗中忽略实例。

Web 设置 `enabled:true`、`port` 与既有 DPAPI accessConfig，或使用 `accessKeyEnv` / `signingKeyEnv`（访问密钥至少 32 字符）。默认只绑定 `127.0.0.1`。HTTP token、CSRF、角色与密钥轮换仍使用既有实现。

北京 18:00/00:00 固定窗口、3 分钟 grace、补报、修订封存、旧原文锚点和普通逐消息 archive_only Admission 不变。`notifications.p0Enabled:true` 明确报 P0_SCHEDULER_NOT_IMPLEMENTED；P0 实时调度仍未交付。

## 组装与启动顺序

1. 解析统一配置、平台配置和所有启用实例的 Manifest / Schema / API / SDK / 权限，拒绝 Source 中的业务策略字段。
2. 初始化一个 M1Runtime（SQLite、Ingress/Archive、Outbox、租约队列、PersistentFeedbackBuffer），取得同库应用 owner。
3. 创建既有 HybridMemory、DomainService、AnalysisWorker 与 GitHubSyncManager；将同一 runtime/memory/domain 注入 createM5。M5 复用 ReportService、ControlPlane、鉴权、通知意图、DurableDeliveryService 和 QQ 状态/撤回逻辑。
4. 加载启用的 Delivery 并执行非发送 probe，启动已配置的 Web / QQ webhook 监听。
5. 为启用 Source 注册身份，各自注入冻结 Host；supervisor 持有 probe/start 及长期任务。主程序同时运行受管理的 M1、M3、M5 循环，外部模型等待不会阻塞 Archive Admission 或报告调度。

应用入口仅组装、注入和管理生命周期，没有另建 Agent、领域逻辑、队列或数据库。平台无关包通过依赖检查禁止引入平台实现；应用组装脚本可以加载具体插件。

## 生命周期、健康与恢复

Source 状态区分 configured/probing/starting/running/unavailable/retry_wait/recovery_wait/failed/stopped，coverage 独立保留 unknown/partial/unavailable。应用 started 只表示启动了管理程序，不能证明平台权限或完整采集。状态还保留错误原因、连续失败次数、最近成功/失败时间及 nextRetryAt。

Discord、Steam Reviews、Steam Discussions snapshot 的 start 已包含自身 sync/轮询，supervisor 监督其长期 Promise，不再并发调用 sync。QQ start 创建后台网关并返回，随后才周期串行 sync/probe。Host 健康异常超出 healthGraceMs 或任务异常结束时停止旧实例，按 maxRestarts、backoffMs 与 maxBackoffMs 有界重建；任何一次都读取 Host 已提交 checkpoint，不使用内存猜测进度。QQ 后台失败经健康上报监督，不能被下一次 sync 擦除。

短期预算耗尽后，可恢复故障进入长期低频恢复，默认每次等待 15–18 分钟后只重建一个实例。runtime.recoveryIntervalMs 默认 900000，允许 300000–86400000；recoveryJitterRatio 默认 0.2，允许 0.1–0.5。未达到稳定恢复条件时，每次长期恢复间隔至少五分钟。明确配置、认证、权限、身份/Checkpoint 和不支持的能力进入 failed，操作员修复后重启。关闭取消全部恢复任务。

`runtime.stableResetMs` 默认 `3600000`，允许 60000–86400000 毫秒。连续确认健康达到该时长后，将已使用的短期预算归零，一次性恢复全部 `maxRestarts`（默认 3 次）；同一稳定周期只执行一次。一次 probe 成功、unknown 能力、成功归档一条消息均不能单独启动计时。任何故障、停机或健康信号失联会重新计时，不能把恢复前后的健康时间拼接。预算仅存在于当前 Supervisor 内存，不另建服务或数据库记录。

QQ WebSocket / Discord 必须完成 READY/RESUMED 的持久提交，并持续有有效的心跳 ACK；不要求玩家发消息。QQ 的连接确认与消息权限 coverage 分开：连接可持续健康，尚无消息证明时 coverage 仍为 unknown；仅有 unknown probe 不会计时。QQ webhook 没有持续连接信号，本轮保守地不为其刷新预算。Steam Reviews 按成功提交的轮询页确认健康，网络、限流、服务器错误及 Checkpoint 异常会中断，即使内部重试随后成功也重新计时。Discussions 仅有效 snapshot 模式的成功提交计时。Gateway 信号间隔超过 5 分钟、Steam 提交间隔超过 max(60 秒, 3×pollIntervalMs) 时，稳定窗口失效；判断至少需要两次合格信号。正式运行使用单调时钟累计时长，墙上时间仅用于展示。

健康状态增加 stableSince、stableResetDone、shortRetriesUsed、budgetResets、lastBudgetResetAt；原 coverage、错误、连续失败、lastSuccessAt 及累计重建次数保留。见 [ADR 0016](ADR/0016-stable-retry-budget-reset.md)。

可信内置定义集中于 scripts/source-registry.mjs，配置解析与 Supervisor 共享注册信息。构造、公共 Manifest 校验、Host 授权/撤权分别独立；新增可信 Source 只需注册和配置。正式 JSON 不接受任意模块路径。QQ Delivery 构造保留独立产品模块，未引入通用 Delivery 系统。详见 [ADR 0015](ADR/0015-source-registry-and-recovery.md)。

每个 Source Host 只暴露 projectId、sourceId、日志、声明内的 getSecret、getCheckpoint、commitBatch 与 reportHealth。Ingress 继续校验运行时 Schema、来源身份、Checkpoint sourceId，并原子保存事件、投影、outbox 和 checkpoint。旧实例 Host 失效后不能再推进进度。插件是可信进程内代码，这些边界不是 JavaScript 或网络沙箱。

SQLite application_owner 以事务互斥取得 token，同机原 PID 存活则拒绝第二个主程序；原进程确认消失后可接管。同主机 PID 复用或外地主机所有者均保守拒绝，必要时人工确认。调试命令不参与正式 owner 协议，不能与正式入口并发操作同库。

停止时关闭回调入口，取消新采集，调用各插件 stop 并等待持有任务与 Core 循环，最后释放 owner、关闭 SQLite。异常插件停止超时会报告失败并使旧 Host 失效；任意第三方实现无视 AbortSignal/stop 时，不保证能强制回收其自建资源。内置插件的正常退出已验证。GitHub 与 QQ unknown 继续沿用权威对账/人工复核，不盲目重发。

## 本轮交付范围

PR A 回滚 #4，PR B 基于 PR A 单独集成；均 Draft，不自动合并。PR #5 保留参考，未合并。PR #4 的工单、临时语音房、服务器配置、Steam 扩展和部署入口保存在 Git 历史，统一入口验收后另行移植。本入口面向已授权公开反馈；私有工单的独立 ACL/披露策略未交付，不应将私有来源接入并向外部模型或 GitHub 披露。

用户已明确无真实数据，因此没有旧 PR #4 库的迁移兼容。运行时新增 012 仅管理主程序 owner；既有 001–011 不变，原 #4 升级库会被哈希账本检查拒绝，不可篡改账本打开。原工作区与其数据、凭据未被覆盖。

测试与实际证据见 [统一入口验收](UNIFIED-APPLICATION-ACCEPTANCE.md)。
