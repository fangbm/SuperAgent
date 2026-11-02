# ADR-005：多意图反馈提取与独立建议生命周期

状态：Draft（v0.5）；适用于 Agent Core 内部，不改变 Source Plugin v1 事件格式。

## 背景和目标

原先 `TriageResultV1.classification` 只能表示一条结果属于一种类型。例如“联机时闪退，希望增加自动重连”同时包含 defect 和 suggestion，单标签会漏掉其中一种。新方案将 `TriageResultV2.items` 设计为 0..N 个独立项，事件依然是一次来源消息，而每个提取项可服务不同的工作流。

## 契约

- `kind=defect`：`category=bug|performance|usability`，额外需要 `observedBehavior`。
- `kind=suggestion`：`category=feature_request|improvement|performance|usability`，额外需要 `requestedOutcome`。
- 非可执行问答和普通聊天：`items=[]` + `nonActionableReason`；原文仍存档。
- 同一来源事件可被多项引用，任何 `EvidenceAnchorV2.eventId` 都是 Host 内部 ID，不是平台 ID。
- 对引文和可选 UTF-16 span 做 Host 原文验证，不得擅自润色/翻译为“原文”。

## 多级身份与幂等

1. **原始事件**：`(source,id)` 唯一，Host 入库后提供 `InternalEventId`。
2. **抽取运行**：`(batchId,pipelineVersion,revision)` 唯一，在调用 LLM 前创建稳定任务/运行身份。
3. **提取项**：Host 事务性写入 `(triageId,extractionIndex)`，模型不提供持久主键。
4. **领域条目**：Bug → `issues`，建议 → `suggestions`；二者均支持多条 `feedback_items` 的关联。

同批次 Retry 先查已提交的结果，禁止重复写领域条目。新模型重新分析采用较高 revision，事务内进行 supersede/reconciliation，不把原有的证据再次计入新增反馈。即使模型在重跑时改变列表顺序，Host 也不应将“新推理候选”当作来自玩家的新消息；通过原文主证据、语义指纹与人工覆盖关系调整现有条目。如果不能可靠对齐，提交人工复核而不是直接增加统计。

> **统计原则**：一条来源消息可以包含多个反馈项，所以 `newFeedbackItems` 可能大于 `uniqueSourceEventCount`；Bug 与建议各自计算热度。一条消息被两个批次当作上下文不能算两次反馈。

## 建议检索与判断

按目标效果、功能域、情景、约束抽取 SuggestionFingerprint，再利用向量检索和精确关键词查询获得候选，交给 SuggestionMatcher 判断 `same_request|related|distinct|uncertain`。偏重避免错误合并：需求相关不等于需求完全相同。例如“支持手柄”与“支持自定义键位”可相关但并非同一工单。

## 建议状态机与人工权限

默认：`candidate → reviewing → accepted → planned → in_progress → implemented → verified`；`reviewing` 或 `accepted` 经人工授权可 `declined`；`declined` 后可 `archived`；若需要重开需带原因并审计。

仅开发者的 Issue/Suggestion Action Service 可以提交状态变化，QQ 只是交互入口。使用 `actorRef` 鉴权、`expectedVersion` 乐观锁、`interactionId` 防重复操作和可选一次性 token。对于 `Implemented` 不等于 `Verified`，两者须分开处理。

GitHub Issues 只接收达到项目门槛、需要开发工作的建议。`enhancement` 标签是推荐值而不是判定真实状态的依据；GitHub close 并不能明确表示“已实现”，同步时必须读取对应关闭原因/管理标记或人工确认。更新 GitHub 时遵循 v0.4 的外部操作状态机；对发送状态 unknown 的 POST 不盲目重试。

## API 与 UI

- `GET /api/v1/feedback?kind=defect|suggestion`：独立提取项。
- `GET /api/v1/suggestions` / `{id}` / `{id}/evidence`：热度与原始消息。
- `POST /api/v1/suggestions/{id}/actions`：状态变更，权限/版本/审计。
- `POST /api/v1/suggestions/merge` / `{id}/split`：人工纠错。
- QQ 建议卡采用 `Details / Accept / Planned / Implemented / Decline`；Details 展示原文分页，不调用 LLM。
- `ReportV2` 分列 defect 与 suggestion 的计数、状态和平台覆盖情况，每日按北京时间 18:00、00:00 输出。

## 迁移与验收

- v0.4 原始事件及插件都无需升级；旧 `TriageResultV1` / `ReportV1` 可继续读，但新任务生成 v2。
- migration 002 以 v0.4 DDL 为基础，新增多意图反馈、建议状态表和统一 `external_work_links`，并把旧 `external_issue_links` 映射复制到新表。
- 迁移前备份生产数据库；文档 SQL 为参考基线，尚未做真实部署升级测试。
- 必须通过 Schema 正反例、TS 错误联合组合、SQLite 双项目同源消息、单批次重试与对外未知写入等测试。
