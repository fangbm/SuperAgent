# ADR 0016：连续健康后恢复短期重试预算

2026-11-04。PR #7 的增量修正，基于 2446d7f，保留 Draft 和对 PR #6 的依赖。本决策补充 ADR 0015，不修改 QQ Operator 注入、不改变 M0 契约或插件 API。

## 原因

长期恢复避免临时网络故障造成永久离线，但原短期预算在本进程内只消耗不恢复。插件健康运行数小时后再次遇到短暂故障，仍必须等待长期冷却。一次 probe 成功不足以恢复预算；空闲群没有消息也不能因此永远无法证明连接稳定。

## 决策

现有 Supervisor 增加 runtime.stableResetMs，默认 3600000，校验范围 60000–86400000 毫秒。连续确认健康达到该时长后，将 shortRetries 归零，一次性恢复全部配置的 maxRestarts（默认 3 次），原指数退避参数不变。同一稳定周期只重置一次；任何故障、连接中断、健康信号过期、实例更换或关闭都会清除稳定计时。长期恢复仍为默认 900000×(1+random×0.2)，即 15–18 分钟，每轮只创建一个新实例。恢复后若再次耗尽短期预算，则再次进入长期恢复。

稳定判断由可信 Source Registry 内部策略识别现有 Host.reportHealth，无新插件方法、配置可执行模块或独立调度器。Supervisor 用单调时钟累计时长；状态时间戳仍用墙上时间。至少两次合格信号，并持续满足信号新鲜度，才可发放预算；probe、消息入库和 lastSuccessAt 的更新均不能单独启动或刷新稳定计时。

| 来源 | 合格信号 | 中断与新鲜度 |
| --- | --- | --- |
| QQ WebSocket | READY/RESUMED 持久提交后 CONNECTED，已认证且对应待确认心跳的 ACK | unavailable 或超过 5 分钟无合格信号；无玩家消息也计时 |
| Discord | READY/RESUMED 持久提交后 CONNECTED，对应待确认心跳的 ACK | Gateway 断线/丢失会话、REST 重试错误、unavailable 或超过 5 分钟无信号 |
| Steam Reviews | 成功归档/推进 Checkpoint 后的完整或可续扫页面 | 网络、429、5xx、Checkpoint 异常；超过 max(60 秒, 3×pollIntervalMs) 无提交 |
| Steam Discussions | 仅 snapshot 模式下有效快照成功提交 | unavailable；与 Reviews 相同的轮询新鲜度限制 |

QQ 的 Gateway 连接确认不代表群权限完整。没有玩家消息时 coverage 仍可为 unknown，但明确的认证连接/心跳证据能证明持续连接；普通 unknown probe 永远不算。QQ webhook 没有这种持续连接证据，本轮保守地不刷新预算。Discussions unavailable 模式不能计时，也不代表实现远端采集。

代码核对发现旧 QQ Source 丢弃正向 Gateway 通知，Discord 断线仍上报 partial，Steam 内部成功重试会隐藏短暂故障。因此连接器通过已有 Host.reportHealth 补齐这些信号。心跳上报与已有持久队列串行，并合并为至多一个待处理健康更新，随正常停机排空；不额外提交事件或推进 Checkpoint。Steam probe 即使内部重试恢复，也会在已启动的实例中报告中断；probe 成功不报告轮询提交成功。

Supervisor 状态增加 stableSince、stableResetDone、shortRetriesUsed、budgetResets 和 lastBudgetResetAt。仅实际补充已消耗的预算才增加 budgetResets；原 restarts/recoveries 保留累计值。预算不持久化，重建仍使用持久 Checkpoint、新实例和撤权后的新 Host。原关闭取消等待、故障隔离及永久错误停止机制保留。

## 验证边界

虚拟时钟覆盖 59:59.999 不恢复、60:00 一次性恢复全部 3 次、稳定两小时不重复、再次故障可用完整 3 次、断线/限流/Checkpoint 异常重新计时、probe-only/unknown 不恢复、心跳失联不累计以及 snapshot 限制。实际连接器类使用可控 WebSocket/HTTP 和真实 SQLite Host，验证空闲 QQ/Discord 心跳、非认证 ACK 拒绝、游标不因心跳前移，以及 Steam/Discord 内部重试中断信号。

完整结果记入 docs/evidence/pr7-stable-budget-reset-2026-11-04.json。本轮不是一小时真实平台连续运行验收，没有真实 QQ/Discord 消息、Steam 请求、付费模型或 GitHub Issue 修改。M0 冻结文件、SDK 和 contracts.freeze.json 保持不变。
