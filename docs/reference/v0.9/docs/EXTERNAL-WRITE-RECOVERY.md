# 外部写入恢复协议（v0.8 统一映射，规范性）

## 绝不承诺网络端到端 exactly-once

本地 idempotencyKey 只对本地任务及外部操作记录有效。外部服务是否支持请求级幂等必须由对应 Provider 的明确 API 契约证实。

### GitHub 创建 Issue

1. 单个内部 Issue + repository 只能有一个未完成 create operation（本地唯一键、租约；`UPDATE ... WHERE state IN (prepared,safe_retry)` 原子抢占，返回 0 行即未取得发送权）。在本地事务中先插入 `external_operations(state=prepared)`、commit；只在提交后对外调用。
2. 发送前将状态更改为 `in_flight` 并提交。GitHub Issue 正文插入固定的非敏感 marker，例如 `<!-- superagent-issue:BUG-0042; op:01H... -->`。标记不应包含隐私信息或 Secret。
3. `201` + 外部 ID：本地同一事务写映射和 `succeeded`。若在写本地之前崩溃，则恢复时视为 `unknown`。
4. `in_flight` 租约过期/网络超时/连接中断/5xx 且无法证明未写入：进入 `unknown`，**禁止自动第二次 POST**。
5. 对账：通过 GitHub API 列出目标 repository 所有 state 的 Issues，按分页读取必要的 Issue 正文确认 marker 和 repository，不能只依赖 GitHub Search 的即时索引，也不能只看 Open Issues；限流时延后。
6. 找到唯一匹配 => **事务内**按 `(work_kind,work_id,provider,repository)` 写 `external_work_links`（同时受 `(provider,repository,external_issue_id)` 唯一约束保护），再置 `external_operations.state=succeeded` 并置 `succeeded`；找到多个 => `manual_review`，列出全部对象；未找到 => 先间隔复查，在规定的查询完整性与可见性策略满足前保持 `unknown`。**没有查询证据不等于证明请求没成功**。长期仍无法确认 => `manual_review`；严禁自动重发。仅经明确证明未提交的失败或人工授权重复风险，才能新建重试操作。
7. webhook 是辅助触发，不作为唯一正确性来源；事件签名、去重与周期对账都必须实现。

### GitHub 更新与评论

- PATCH 前记录目标字段和基准 revision；重试前先读远端并比较 Agent 所管理区块/状态。如果目标状态已生效，标成功；若状态冲突，暂停人工干预而不覆盖开发者文本。
- 创建评论是另一个可能重复的 POST。评论正文使用 correlation marker，结果未知时遍历机器人评论并按 marker 对账。不能简单重试。

### QQ C2C 发送

1. 同一 report + channel + recipient 只能创建一个 delivery operation；发送前持久化意图。
2. 有明确成功响应并保存 providerMessageId -> `accepted`（仅平台受理，不是已读）。有明确权限拒绝 -> `blocked`。
3. 超时/断线/进程崩溃且请求可能已到服务端 => `unknown`，不能自动把它当作 `retryable`。
4. 只有平台明确提供 request-id 幂等或可核对的消息回执/历史查询时才能自动查证或安全重试；当前不能假定 QQ C2C 有可靠的客户端幂等或消息历史查询能力。
5. 无确认能力时，`unknown` 经配置的观察期进入 `manual_review`。报告已经留存 Web；开发者可手动重试，但 UI 必须提示“可能重复发送”，新操作需独立审计。

## 状态机

`prepared → in_flight → succeeded / blocked / unknown`；`unknown → reconciling → succeeded / unknown / manual_review`；`prepared / 已证实无副作用失败 → safe_retry → in_flight`。

禁止 `unknown → safe_retry` 仅凭超时、没有回执、搜索暂未命中或无 webhook。

## 故障注入验收

1. GitHub POST 成功后但保存本地映射前 kill -9：恢复时能够通过 marker 找到目标 Issue，仅一份工单。
2. GitHub POST 超时但服务端确实创建：不发第二次 POST，完成对账。
3. GitHub 查询限流/索引延迟：保持 unknown，退避后继续对账，无法确认时人工处理。
4. GitHub 多个 marker 命中：停止写入、告警，不自动随意选一个。
5. QQ API 发送成功但客户端超时：标记 unknown、不自动重发；Web 报告正常可见。
6. QQ 明确返回权限不足：blocked、不无限重试。
7. 两个 Worker 同时处理同一个外部操作：租约与唯一键只允许一个调用。
8. 已发送报告的人工重试要求明确确认“可能产生重复消息”，留下两次独立操作记录。

**开发限制：** `in_flight` 租约过期的操作只能进入 `unknown` / `reconciling`，不允许重新置为 `prepared` 立即调用。同 `(source,id)` 却出现不一致原文时是事件身份冲突，不属于可无条件重试的重复事件。

### v0.8 单一映射表一致性

- `external_issue_links` 仅用于从 v0.4 迁移到 v0.5（migration 002），任何运行时读取、创建、重试恢复与 Webhook 对账均只使用 `external_work_links`。
- `work_kind` 必须显式为 `defect` 或 `suggestion`。来源为 `github.issue.create` 时由操作目标读取受信内部领域类型，不能靠 Issue 标题判断。
- 当远端成功但本地崩溃：查询远端 Marker；找到唯一后**同一事务**插入统一映射并置 `succeeded`，事务提交前若崩溃则继续 `unknown` 对账；不允许先置 succeeded 后写映射。
- 若唯一键冲突（同内部工单映射另一个远端 Issue，或远端 Issue 已映射其他工单），整个事务失败，转 `manual_review`；不得改写旧表以规避冲突。
