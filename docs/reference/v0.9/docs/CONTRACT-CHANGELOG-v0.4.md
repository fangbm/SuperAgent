# v0.3 → v0.4 契约变更清单

| 编号 | v0.3 缺口 | v0.4 结论 | 关联文件 |
|---|---|---|---|
| C-01 | CloudEvents `(source,id)` 与内部 `eventId` 混用 | 内部使用 Host 分配的 `InternalEventId`；来源去重用 `(source,id)`；重复提交返回相同映射 | `agent-contracts.ts`, `migrations/001_core_id_and_external_effects.sql` |
| C-02 | `type` 与 `data` 是松散联合 | TypeScript 判别联合映射 + JSON Schema `oneOf`，严格验证 `data.object.kind` | `agent-contracts.ts`, `schemas/normalized-event-v1.schema.json` |
| C-03 | 文档写了 `AgentCoreV1`，未导出/缺 Run 类型 | 补齐 `AgentCoreV1`, `AgentRunViewV1`, 内部 ID 入参 | `agent-contracts.ts`, `tests/types.contract.ts` |
| C-04 | 外部 POST 超时与崩溃恢复未定义 | 持久操作记录；不确定发送状态 `unknown`；GitHub 标记对账；QQ 不盲目重试 | `docs/EXTERNAL-WRITE-RECOVERY.md`, `migrations/001_core_id_and_external_effects.sql` |

## 与 v0.3 的兼容性

本项目目前仍在 Draft 阶段，**v0.4 是接口收敛而非发布后的无损兼容升级**。打算实现 v0.3 的代码需要更新：

- 所有旧 `eventId: string` 迁移为 Host 内部 `InternalEventId`，不能将 CloudEvents `.id` 直接透传给 Core。
- `CommitResultV1` 新增必填 `refs`；事件仓库必须使用 `(source_uri,external_event_id)` 唯一约束。
- `NormalizedEventV1` 按 `type` 限制 `data`，新增评论和删除事件类型。
- `DeliveryResultV1` 新增 `unknown`，调用方必须显式处理，不可作为普通 `retryable`。
- `IssueTrackerProviderV1.create/update` 现在接收 `ExternalOperationV1`，外部操作记录须在发送前已持久化。
- 本包提供**新部署参考 DDL**，若已有运行中的数据库，应单独编写数据迁移并检查旧记录中来源 ID 与内部 ID 是否混用。

## 验证范围

已提供静态类型检查、JSON Schema 正反例和 SQLite 约束检查；**未进行** GitHub/QQ 真实故障注入、网络恢复和并发多实例测试。真实平台的发送权限及对账能力仍需 M0/M6 验证。

## 官方 API 参考

- GitHub REST Create Issue: https://docs.github.com/en/rest/issues/issues （无文档化的 `Idempotency-Key` 参数；不要假设支持）
- GitHub REST List Repository Issues: 同上（对账时必须查询所有状态并处理分页与 PR 混入）
- QQ 官方消息收发接口: https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html （主动发送配额/能力需要实际验证）
