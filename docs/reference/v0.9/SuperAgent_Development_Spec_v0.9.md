# SuperAgent 跨平台游戏反馈系统 — 开发规范 v0.9

> 状态：**Draft / Contract-first**  
> 日期：2026-11-02  
> 面向：架构设计、Agent Runtime、插件开发、前后端实现、测试与运维  
> 关联契约：[`agent-contracts.ts`](./agent-contracts.ts)；默认调度配置：[`reporting.default.json`](./reporting.default.json)；缓冲批处理配置：[`batching.default.json`](./batching.default.json)；通知分流：[`notifications.default.json`](./notifications.default.json)  
> 决策优先级：**Agent Core API > 插件协议 > 业务流程 > 平台 SDK 细节**

## 0. 项目目标与范围

本项目是一个**自研、跨平台、可持续运行的游戏社区反馈 Super-agent**。输入来自 QQ 官方机器人、Discord、Steam 评论、Steam 讨论区等插件；Agent Core 对数据进行理解、跨平台去重、归因辅助、优先级评估和历史关联；每天北京时间 18:00 和次日 00:00 各生成一份开发者反馈报告；**只有 P0 Bug 实时 QQ 私聊告警，其余 Bug、Steam 差评和玩家建议均只随半日报主动投送**；Web 控制台持续归档。

**第一阶段必须交付：**
- 即使群消息极多，也要**每条可靠采集、少量批次调用 Agent**；无价值消息不触发完整推理，但允许重新分析。
- 各平台接入均作为 `SourcePlugin`，只负责发现、读取、转换及可靠提交事件。
- Agent Core 不导入任何 QQ、Discord、Steam 的类型或 SDK。
- 所有原始事件先持久化再异步分析；消息、编辑、删除和采集不完整状态均可表达。
- 一条消息可抽取多条独立 Bug / 建议，均有可追溯的证据引用；允许开发者手动合并、拆分及纠正。
- 反馈报告默认每天北京时间 18:00、次日 00:00 生成，统计窗口互不重叠，调度与投递解耦。
- **主动通知白名单**：仅 P0 Bug 允许实时 QQ 私聊；非 P0、Steam 差评与建议不得产生独立即时推送任务。P0 仍计入半日报。
- Web 控制台能够查看事件、Issue、报告、采集健康、任务和投递状态。

**第一阶段明确不做：**
- 每收到一条群消息就启动一次完整 LLM 推理或 GitHub API 写入。
- 把时间相近的所有群消息自动认定为同一 Bug。
- 自动在玩家群或 Steam 讨论区发言。
- 因 GitHub Issue 创建、状态变化、热门建议或差评上涨而额外向开发者立即推送（P0 Bug 除外）。
- 自动修复代码、提交 PR 或执行 LLM 生成的任意 Shell 命令。
- 依赖 QQ 主动私聊“必然可用”的业务假设。
- 将一个平台的 SDK 对象直接持久化为公共业务模型。
- 第三方插件完全可信的运行时沙箱（第一版只允许经过审核的内置插件）。

## 1. 设计原则与层次边界

1. **契约先行**：先冻结 v1 事件契约、SDK 接口和业务命令，再编写平台适配器。
2. **输入统一**：所有外部内容统一为 `NormalizedEventV1`；Adapter 不直接创建 Issue。
3. **可靠优先**：从平台收到的数据经 Host 原子保存并确认后，才可推进同步 checkpoint；后台筛选和批处理失败不得影响原始事件留存。
4. **最小权限**：Source 只有读和发布权限；Delivery 只能向开发者批准的收件目标投递。
5. **业务与模型解耦**：模型产出结构化建议，由领域服务校验后提交，而非直接操作数据库。
6. **可追踪**：每个分类、合并、优先级和报告条目均可追溯到Host 内部证据 ID 与模型/规则版本。
7. **可恢复**：任务和定时器状态持久化；实例重启按租约恢复。
8. **可迁移**：MVP 单机 SQLite、进程内可信插件；未来可换 PostgreSQL/隔离插件进程而不改变事件契约。
9. **按需唤醒**：Ingress 对每条消息执行，但完整 Agent 只对独立的反馈批次执行。
10. **证据不丢**：重复传输事件幂等去重，同一 Bug 的独立玩家原文全部保留，语义相似不得抹去原文。

### 1.1 分层架构

```mermaid
flowchart TD
  QQ[QQ SourcePlugin] --> ING[Ingress Host API]
  DC[Discord SourcePlugin] --> ING
  SR[Steam Review SourcePlugin] --> ING
  SD[Steam Discussion SourcePlugin] --> ING
  ING --> TX[(Event Store + Cursor)]
  TX --> Q[Durable Ingress Outbox]
  Q --> F[Lightweight Filter / Admission]
  F --> BUF[(Persistent Feedback Buffer)]
  BUF --> SEG[Conversation Segmenter]
  SEG --> BAT[Adaptive Batch Scheduler]
  BAT --> RT[Agent Router / Worker Runtime]
  RT --> MEM[(Defects / Suggestions / Evidence / Memory)]
  MEM --> GSYNC[GitHub Issue Sync Adapter]
  GSYNC --> GH[GitHub Issues]
  MEM --> POL[Notification Policy: P0 Only]
  POL --> PA[P0 High Priority Alert Outbox]
  PA --> QQO
  MEM --> REP[Report Generator]
  REP --> RDB[(Report Archive)]
  REP --> DQ[Delivery Queue]
  DQ --> QQO[QQ C2C DeliveryPlugin]
  RDB --> WEB[Web Console / Admin API]
  MEM --> WEB
  WEB --> ACT[IssueAction + SuggestionAction API]
  ACT --> MEM
```

**依赖方向**：插件 → SDK 契约 → Host；Agent Workers → AgentContext → 领域服务；Web → Admin HTTP API。任何插件禁止反向依赖 `core` 的内部实现，Core 禁止导入具体 `connectors/*`。

## 2. 插件 API 规范：`superagent.io/plugin/v1`

### 2.1 插件分为两类

| 插件种类 | 核心方法 | 允许能力 | 不允许能力 |
|---|---|---|---|
| `source` | `probe/start/sync/stop` | 读取授权数据、标准化、提交事件、上报健康 | 直接写 Issue、查询其他插件凭证、对玩家发消息 |
| `delivery` | `probe/send` | 按 Host 批准的目标投递指定报告 | 枚举聊天对象、自选收件人、向玩家群发送 |

同一 QQ 服务可以有**两个不同插件实例**：`qq-official-source` 与 `qq-official-c2c-delivery`。不能因为二者使用同一平台，就允许 Source 获得发信权。

### 2.2 插件 Manifest

每个插件提供 `manifest.json`，声明插件身份、SDK 兼容版本、类型、权限和配置 JSON Schema：

```json
{
  "apiVersion": "superagent.io/plugin/v1",
  "id": "com.superagent.source.qq-official",
  "version": "0.1.0",
  "displayName": "QQ Official Source",
  "kind": "source",
  "engine": { "sdk": "^0.1.0" },
  "permissions": {
    "networkHosts": ["api.bot.qq.com"],
    "secretKeys": ["QQ_APP_ID", "QQ_APP_SECRET"],
    "eventPublish": true,
    "deliverySend": false
  },
  "configSchema": {
    "type": "object",
    "properties": { "sourceId": { "type": "string" } },
    "required": ["sourceId"],
    "additionalProperties": false
  }
}
```

Host 在加载时检查 `apiVersion`、`engine.sdk`、配置 Schema 和权限。网络域名白名单在第一版进程内插件中是**审计声明**，不是可保证的沙箱隔离；不受信任的第三方插件必须等独立进程/容器及实际网络与 Secret 隔离机制完成后再开放。

### 2.3 Source 插件生命周期

`registered → configured → probing → ready/partial/degraded → stopping → stopped`

- `probe()`：检查当前账号/来源的**实际可用能力**，不得只依据 SDK 具有某个方法就返回可用。
- `start(host, signal)`：开启推送流、心跳与重连；响应 AbortSignal；可长期运行。
- `sync(host, signal)`：执行一次有界的增量补采；Host 定时调用，不允许插件自己无限创建任务。
- `stop()`：释放连接，停止新的事件提交。
- Host 记录 `coverage: full | partial | unknown | unavailable`，覆盖不全必须呈现在控制台和报告。

Source 的 Host 最重要方法：

```ts
interface SourcePluginHostV1 {
  projectId: string;
  sourceId: string;
  getCheckpoint(): Promise<JSONValue | null>;
  commitBatch(
    events: readonly NormalizedEventV1[],
    checkpoint?: { sourceId: string; cursor: JSONValue }
  ): Promise<{
    accepted: number;
    duplicates: number;
    transactionId: string;
  }>;
  getSecret(key: string): Promise<string>;
  reportHealth(info: {
    coverage: "full" | "partial" | "unknown" | "unavailable";
    reason?: string;
    checkedAt: string;
  }): Promise<void>;
}
```

**关键不变量**：`commitBatch(events, checkpoint)` 是同一 SQLite 事务：验证事件 → 插入事件（去重）→ 写入 outbox/待处理任务 → 推进 cursor → 提交。任一步失败，整批回滚。Adapter 只能在成功返回后确认上游事件或继续分页。对于实时事件没有持久 cursor 的平台，可省略 `checkpoint`，靠 `(source,id)` 的幂等去重。

批量事件只允许来自同一 `sourceId`；**只要有一个事件未通过校验，整批必须失败并回滚，checkpoint 不推进**。`accepted` 与 `duplicates` 只在整个事务成功后返回。

### 2.4 Delivery 插件协议

```ts
interface DeliveryRequestV1 {
  deliveryId: string;
  idempotencyKey: string;
  projectId: string;
  reportId: string;
  recipientRef: string;
  title: string;
  text: string;
  requestedAt: string;
}

interface DeliveryPluginV1 {
  probe(): Promise<{available: boolean; reason?: string}>;
  send(request: DeliveryRequestV1, host: DeliveryPluginHostV1):
    Promise<{
      status: "accepted" | "rejected" | "retryable" | "blocked" | "unknown";
      providerMessageId?: string;
      errorCode?: string;
      retryAfterMs?: number;
    }>;
}
```

收件人只由管理员预先绑定并保存为 `recipientRef`，LLM 不能生成 QQ OpenID、选择收件人或调用 `send()`。`accepted` 仅表示接口已受理，不等于用户已收到或阅读。`retryable` 仅适用于**已证明请求未提交**或 Provider 明确保证幂等的场景；发送后结果不明一律 `unknown`。QQ 主动私聊若返回无权限，应标记 `blocked`，报告依旧归档 Web，不应无限重试。

## 3. 统一事件协议：`NormalizedEventV1`

### 3.1 Envelope

使用 **CloudEvents 1.0 风格**的 JSON envelope（不是宣称实现所有 CloudEvents 传输协议），保留 `specversion/id/source/type/time/subject/datacontenttype/data`；`(source,id)` 在来源事件级唯一，Host 另生成全局 `event_id`（`InternalEventId`），并将其作为领域证据、批次和 Agent Core 的唯一引用。业务 Schema 在 `data.schemaVersion` 中独立版本化。

CloudEvents 规范要求 `specversion`、`id`、`source`、`type` 为核心属性，适合为跨平台事件提供统一外壳。本项目 v0.1 使用固定 JSON 形式，契约参考：https://github.com/cloudevents/spec 。

**事件类型（v1，按对象种类×动作构成，见 TS 的 `FeedbackEventKindMapV1`）**：

```text
com.superagent.feedback.message.created.v1
com.superagent.feedback.message.updated.v1
com.superagent.feedback.message.deleted.v1
com.superagent.feedback.review.created.v1
com.superagent.feedback.review.updated.v1
com.superagent.feedback.review.deleted.v1
com.superagent.feedback.thread.created.v1
com.superagent.feedback.thread.updated.v1
com.superagent.feedback.thread.deleted.v1
com.superagent.feedback.comment.created.v1
com.superagent.feedback.comment.updated.v1
com.superagent.feedback.comment.deleted.v1
com.superagent.source.coverage.changed.v1
```

**示例：QQ 群内新消息（虚构值，`id` 是外部事件 ID 而非内部 `eventId`）**

```json
{
  "specversion": "1.0",
  "id": "ev-29f8b1",
  "source": "urn:superagent:source:qq-group-01",
  "type": "com.superagent.feedback.message.created.v1",
  "time": "2026-11-02T12:41:20Z",
  "subject": "message/msg-12345",
  "datacontenttype": "application/json",
  "data": {
    "schemaVersion": "1.0",
    "projectId": "game-01",
    "sourceId": "qq-group-01",
    "platform": "qq-official",
    "object": {
      "kind": "message",
      "externalId": "msg-12345",
      "revision": "original"
    },
    "actor": { "opaqueId": "member-token-01", "isBot": false },
    "content": {
      "text": "多人联机加载到 90% 会闪退",
      "language": "zh-CN",
      "attachments": []
    },
    "origin": { "locale": "zh-CN" }
  }
}
```

注意：`id` 是来源事件 ID 示例；正式实现按平台稳定事件 ID 生成，必要时可确定性构造（须保证同一 `(source,id)` 的语义稳定）。Host 入库时另分配内部 `event_id`，不得把 `id` 当作 Core `eventId`。不得将个人 QQ 号码或密钥嵌入事件 ID。`source` 使用稳定的内部来源命名空间（URI，例如 `urn:superagent:source:qq-group-01`），不暴露平台敏感标识；`data.sourceId` 是配置对象 ID。

### 3.2 平台数据规范化规则

| 平台字段 | 标准字段 | 备注 |
|---|---|---|
| QQ 消息 ID / Discord Message ID / Steam Review ID | `data.object.externalId` | 同一 `sourceId` 内唯一 |
| 修改时间或修订标识 | `data.object.revision` | 没有修订号时用稳定内容哈希或来源事件 ID |
| 发言正文 / 评论正文 | `data.content.text` | 允许 `null`，如删除事件或无文本附件 |
| 回复目标 | `data.object.parentExternalId` | 可选 |
| 讨论串 ID | `data.object.threadExternalId` | 可选 |
| 消息原帖 URL | `data.origin.permalink` | 可选；不能伪造不存在的链接 |
| 附件 | `data.content.attachments` | 引用 Host 保存的资源或原始受控 URL |
| 发送者身份 | `data.actor.opaqueId` | 不进入开发者报告的个人身份识别信息 |

必须支持编辑和删除：原始事件为不可变记录，**删除事件不物理改写历史事件**，而是更新当前投影与可见性，并遵循隐私删除/保留政策。Steam 评价可能更新，QQ/Discord 可能编辑消息；如果平台无法提供编辑事件，使用增量同步发现变动并按版本保存。

### 3.3 幂等、顺序与时间

- **双身份命名**：`NormalizedEventV1.source` + `.id` 是唯一的来源事件键；`source_events.event_id` 是 Host 首次提交时生成的全局内部 ID。后者通过 `CommitResultV1.refs` 映射，重复重放返回同一内部 ID。
- `EvidenceRefV1.eventId`、`FeedbackBatchV1.candidateEventIds/contextEventIds`、`AdmissionDecisionV1.eventId`、`FeedbackBufferV1.admit()`、`AgentContextV1.evidence.get()`、`AgentCoreV1.accept()` 全部**只接受 Host 内部 `InternalEventId`**。
- 事件重放不能产生重复领域写入；建立 `UNIQUE(source_uri,external_event_id)` 并保持 `event_id` 不变。若相同 `(source,id)` 携带**不同事件内容**，必须报 `EVENT_IDENTITY_CONFLICT`、隔离审查且不推进 checkpoint，不得静默覆盖第一版原文；正常的编辑应使用新的事件 ID 并修改对象的 `revision`。
- 来源对象当前状态键：`(sourceId, object.externalId)`；不同修订按 `revision` 追加。
- `occurred_at = event.time` 是平台事件时间，`received_at` 由 Host 在入库时生成。
- 报告计入窗口以 **Host received_at** 为准，保证漏采恢复后的事件进入某个明确的报告窗口；报告可另外展示原帖时间。
- 不假定跨平台有全局顺序；同对象更新以来源版本及时间策略处理，乱序事件进入待协调队列。
- 不将所有同一文本的评论直接去重：来源事件去重与语义 Bug 聚类是两个独立操作。

### 3.4 版本演进

- 插件接口使用 `superagent.io/plugin/v1` 主版本；破坏性变更开 `/v2`。
- 事件类型后缀 `.v1`；业务 data 使用 `schemaVersion: "1.0"`。
- v1 内只允许新增**可选字段**；必填字段或含义变更必须升版本。
- Host 保留至少一个旧主版本的**迁移工具**；插件加载不兼容时必须失败并给出明确错误，而非静默丢字段。
- CI 使用共享 fixtures + JSON Schema + TypeScript 类型测试进行契约测试。

## 4. Agent Core API

### 4.1 Core 只接受事件和任务

Core 的公开边界已与 TypeScript 契约一致（`AgentCoreV1` 与 `AgentRunViewV1` 均由 `agent-contracts.ts` 导出）：

```ts
export interface AgentCoreV1 {
  accept(eventId: InternalEventId): Promise<{ jobId: string }>;
  enqueue(task: AgentTaskV1): Promise<{ jobId: string }>;
  getRun(runId: string): Promise<AgentRunViewV1 | null>;
  requestReport(window: ReportWindowV1): Promise<{ reportId: string }>;
}
```

`AgentRunViewV1` 包含 `runId/jobId/projectId/workerId/status/attempt/inputEventIds/queuedAt`，以及可选的开始结束时间、模型与错误信息。未找到执行记录返回 `null`。

`accept()` 从可信事件仓库读取，并不接受直接传入的平台 SDK 消息对象。主入口 `feedback.received` 由持久 outbox 生成。**调用 `accept(eventId)` 不意味着启动完整 LLM Worker**：它可以只创建一次轻量 admission 工作，或者标记为无需分析。第一版 Core 可以是同一进程中的服务接口，不要求暴露为公网 HTTP。

### 4.2 自研 Runtime 与 Worker

运行时采用**持久化 DAG + 有界自主决策**，不是不断重复调用 LLM 的无限 loop：

```text
ingest (每条消息, 不调用 LLM)
  → lightweight admission (规则/小模型，可批次执行)
  → persistent feedback buffer
  → conversation segmentation (引用/线程/话题/时间)
  → adaptive batch flush (到时/达到阈值/紧急)
  → full Agent triage → retrieve candidates → evidence match
                                               ├─ link existing Issue
                                               ├─ hold uncertain candidate
                                               └─ create new Issue
  → assess severity → update memory → GitHub async sync
```

- `Router`：由事件/任务类型选择工作流和下一步，首先采用确定性规则；需要模型判断时调用受约束的 LLM Tool。
- `Worker`：有明确输入、输出 Schema、超时、重试预算、执行身份和权限。
- `AgentContext`：唯一工具入口，包括 `evidence.get/search`、`issues.search/proposeChange`、`llm.generateStructured`。
- `DomainService`：检查证据存在、状态变更合法、权限允许后提交 Issue 修改。
- `Memory`：保存问题、反馈、语义向量、开发者修正记录；不向 Adapter 暴露内部数据结构。

**AI 的输出永远是提案**：例如 `proposeChange` 必须附带 `EvidenceRef[]`；没有证据的结论无法写入正式 Issue。模型的置信度不是客观概率，不应直接等同准确率。

### 4.3 多意图分类与提取契约（v0.5）

**新写入路径使用 `TriageResultV2`；`TriageResultV1` 保持只读兼容**，不再用于新批次。一个 `FeedbackBatchV1` 包含多个 Source Events，模型可以输出 `0..N` 个独立的 `FeedbackItemV2`：

- `kind = defect`：`category = bug | performance | usability`。需要记录现象、预期行为和可选复现步骤。
- `kind = suggestion`：`category = feature_request | improvement | performance | usability`。需要记录希望达成的效果（`requestedOutcome`），可选动机和目标功能。
- `question` 与 `other` 属于非可执行对话，不伪造 `FeedbackItem`；结果使用空 `items` 和 `nonActionableReason`，同时保留原始消息和初筛记录。
- 模型返回的 `confidence` 不是校准概率；低置信度只影响自动处理策略，不能导致源事件被删除。

**同一条消息可以同时包含 Bug 和建议**。例如“联机闪退，希望有断线自动重连”：提取为一个 `defect/bug` 和一个 `suggestion/feature_request`，两项通过 `EvidenceAnchorV2.eventId` 引用同一个 Host 内部事件 ID；它们有**不同的 `feedback_item_id`**。同样一条消息还可能包含多个互不相关的建议，不能强制合成一项。

`EvidenceAnchorV2` 可附带精确引文和可选字符偏移，Host 必须校验锚点对应持久化原文；不得把 AI 改写的文本伪装成原文。`role=context` 的证据提供语境，但**不单独计入新反馈**。抽取输入与输出的详细示例见 `fixtures/triage-mixed-intent-v2.json`；运行时 Schema 位于 `schemas/triage-result-v2.schema.json`。

**身份及去重**：Source Event 身份始终是 `(source,id)`，Host 内部标识是 `InternalEventId`，独立提取项目身份由 Host 赋予。批次抽取先固定 `triage_id = (batchId,pipelineVersion,revision)` 的唯一持久记录，再执行 LLM；成功结果先完整落库再触发领域任务。每个结果中的项目使用 `(triage_id, extraction_index)` 唯一定位；同一 `triage_id` 重放只能重读已提交结果。批次重分析要生成新 revision，旧项目以 `superseded` 历史版本保留，不得将其再次计为新玩家反馈。连续的多个上下文批次引用同一个原始事件也不应重复增加统计。人工 Split/Merge 不删除任何证据。

**兼容规则**：`NormalizedEventV1`、`FeedbackBatchV1`、`SourcePluginV1`、`DeliveryPluginV1` 及 `AgentCoreV1.accept()` 签名保持不变。变化仅位于 Agent 内部分类结果 `TriageResultV2` 与新增建议领域接口；建议专用 Worker 使用 `AgentContextV2`，`AgentContextV1` 保持不变。旧 `TriageResultV1` 可转换成 v2 供查看（转换时 `other/question` 映射空 `items`），但不可凭旧数据推断缺失的意图。

### 4.4 工具权限模型

| 工具 | 权限级别 | 默认策略 |
|---|---|---|
| 读取已入库原始反馈 | `read.evidence` | 允许，同项目范围 |
| 查询历史问题与相似反馈 | `read.issues` | 允许 |
| 提交内部 Issue 变更提案 | `write.issue.proposal` | 允许，经规则校验 |
| 正式变更 Issue | `write.issue.commit` | 只允许 DomainService |
| 触发报告生成 | `write.report` | 调度或管理员允许 |
| 对外发送消息 | `external.send` | 仅 Delivery Manager，收件人白名单 |
| 任意 Shell/文件系统/仓库写入 | `external.execute` | MVP 禁止 |

玩家消息、Steam 评价和链接页面都按**不可信数据**处理。不得将内容作为系统提示词、插件权限配置或 Agent 动作批准来源。


### 4.5 高频消息处理 API（v0.3 新增）

**原则**：每条合法且已授权的消息都由 SourcePlugin 提交至 `Event Store`；Event Ingress **零 LLM 调用**。完整 Agent 只对值得分析的**会话片段（Conversation Segment）/反馈批次（Feedback Batch）**执行。任何阶段都不能以“减少模型费用”为由静默删除原文。

流水线分成三个独立职责：

1. **AdmissionFilter**：可在小批量消息上运行确定性规则或低成本分类器。结果为 `candidate | urgent_candidate | needs_context | archive_only | audit_sample`。`archive_only` 仍保存在 Event Store，记录筛选策略版本，之后可重处理。过滤不得基于单一关键词排除所有反馈；需抽样审计漏报。
2. **ConversationSegmenter**：依据平台线程/回复 ID 优先聚合；其次结合时间窗口、话题与参与者切分。相同时间段的不同讨论不能强行归类为一个话题。跨群、跨平台在这一步**不合并**；跨平台关联由后面的 BugMatcher 做。
3. **AdaptiveBatchScheduler**：在段落静默超时、积压时间上限、候选消息数量上限或严重问题快速通道触发时，生成 `FeedbackBatchV1` 并提交 `feedback.batch.triage` 任务。批次仅组织处理，**不改变每条消息的独立证据身份**。

核心 TypeScript 契约位于 `agent-contracts.ts`；批次运行时数据的机器校验位于 `schemas/feedback-batch-v1.schema.json`。建议形式：

```ts
interface FeedbackBatchV1 {
  schemaVersion: "1.0";
  batchId: string; projectId: string; sourceId: string;
  segmentIds: string[];
  candidateEventIds: InternalEventId[];
  contextEventIds: InternalEventId[];
  policyVersion: string;
  revision: number;
  reason: "quiet_timeout" | "max_wait" | "size_limit" | "urgent" | "replay";
  createdAt: string;
}

interface FeedbackBufferV1 {
  admit(eventId: InternalEventId): Promise<AdmissionDecisionV1>;
  flush(segmentId: string, reason: FeedbackBatchV1["reason"]): Promise<string>;
  recoverStale(now: string): Promise<number>;
}
```

`admit` 必须是幂等的。批次标识/幂等键以 `projectId、sourceId、segmentId、revision、policyVersion` 构造，禁止依赖进程内随机状态；同一个事件可以作为相邻批次的**上下文**重复出现，但只能作为一个新反馈实体被计数一次。重复转发的消息要保留独立事件身份，再通过明确的跨平台转载/相似关系处理。

#### 默认 `BatchingPolicyV1`

| 配置 | 初始值 | 说明 |
|---|---:|---|
| `quietWindowMs` | 60,000 | 片段在没有新相关消息后可 flush |
| `maxWaitMs` | 120,000 | 即使高流量持续也强制结束当前段，防止饥饿 |
| `maxCandidateMessages` | 30 | 候选消息达到此数立即 flush；非全部群消息数 |
| `maxContextMessages` | 50 | 单次分析引入的上下文上限，可按 token 再截断 |
| `urgentMaxDelayMs` | 5,000 | 严重线索快速通道目标，不保证平台端到端时延 |
| `auditSampleRate` | 0.02 | 随机抽检归档消息的初始比例，按来源调优 |
| `maxConcurrentFullAgentJobs` | 3 | 全局完整 Agent 并发上限，按模型额度配置 |

这些数字是**可配置的 MVP 初值**，并非经真实数据验证的最优值。具体字段放在 `batching.default.json`，由 Host 配置，插件不得绕过或私自修改。

#### 有界上下文、排队与退化行为

- 会话片段按 `sourceId + thread/reply topology + topic` 管理；关联上下文可跨批引用，但每条原始消息只算作一次新反馈。上下文过长时使用检索/截断，并记录未读取的范围，不能让模型误以为输入完整。
- `urgent` 在任何时间都可提前 flush，但仍受真实性/误报验证；数据损坏、安全问题等优先级靠明确的特征或规则触发。
- Host 将 `ingress/admission/full_agent/report/delivery` 分离为持久任务队列或逻辑队列，分别控制并发与配额，避免群聊流量影响 18:00、00:00 报告任务。即使模型不可用，收集端也不应被模型请求阻塞。
- 当令牌额度或模型服务触发背压时，只暂停/降频分析，不应无声丢弃合法事件。队列积压、最旧待分析年龄、来源覆盖率需可观测且在报告中披露。
- 使用时间窗口与持久化状态恢复 flush 定时器：启动时扫描超时 segment，按确定性幂等键补建批次。原始内容被编辑或删除后，用修订事件安排受影响片段重处理，并维护投影和删除策略。

#### 测量指标与成本口径

至少统计：`source_events_ingested`、`admission_candidate_rate`、`archived_events_audited`、`batch_size_distribution`、`batch_flush_reason`、`full_agent_runs`、`llm_tokens`、`llm_cost`、`oldest_pending_seconds`、`feedback_detection_recall`。**批处理减少的是完整 Agent 启动次数，不必然等比例减少 token 成本。**

### 4.6 Bug 匹配与 GitHub Issues 同步（v0.3 新增）

Bug 相似性采用 `BugFingerprint → Hybrid Retriever (Embedding + FTS/BM25) → LLM Evidence Matcher → IssueResolver`。按触发条件、表现、错误特征、版本、平台、复现步骤比较；绝不只按“文本相似度高”合并。输出 `same_issue | related | different | uncertain`，必须记录支持、冲突和缺失证据。模型置信度不是可直接使用的客观概率。

- 新反馈**总是保存独立原文**，同一 Bug 的 100 条反馈可链接到 1 个内部 Issue；`Details` 查询返回全部有权查看的原始消息。
- 可以自动创建正式内部 Issue 并经独立的 `IssueTrackerProvider` 插件同步 GitHub；证据不足时先创建 `candidate` 并等待更多报告。
- 已有 Issue 收到重复反馈：更新本地数量/趋势；GitHub 通过**批量合并更新**专用统计区域或机器人评论，而不是每条新消息发一条通知。新的复现步骤、错误日志、受影响版本等显著新证据可触发更及时的 GitHub 更新。
- GitHub 与本地通过 `external_work_links` 关联。GitHub 工作流状态为已同步工单的状态权威，原始证据与语义关联则以本地数据库为权威。所有外部写入由 Durable Outbox 驱动、限流、**本地去重与远端对账**，不能由 LLM 直接调用 GitHub API；严禁覆盖开发者人工编辑的内容。
- `Fixed` 是开发者确认修复，`Verified` 是修复被验证，两者不同；疑似复发时 Agent 提醒开发者而非自动否定人工确认。

### 4.6a 玩家建议独立匹配与生命周期（v0.5）

建议不进入 BugMatcher。使用独立的 `SuggestionFingerprint → HybridRetriever → SuggestionMatcher → SuggestionResolver`；按**目标功能、期望结果、用户场景及约束**判断是不是同一需求，而不是仅比较文本相似。例如“支持 Xbox 手柄”和“增加手柄操作”可以作为同一需求候选，但“支持震动反馈”一般应为相关子需求而非直接合并。

`SuggestionMatchResultV1.relationship = same_request | related | distinct | uncertain`；记录相同目标、冲突约束及区分细节。即使需求合并，所有建议原文及来源照常保留。建议热度应区分消息数、独立反馈者数（仅在隐私允许且标识可靠时）和涉及平台数。

建议状态机：

```text
candidate → reviewing → accepted → planned → in_progress → implemented → verified
             └────────→ declined ────────────→ archived
```

也允许 `accepted → declined`（有审计理由）、`implemented → reviewing`（发现未达成目标）、`declined → reviewing`（人工重开）；具体迁移由领域服务的白名单配置约束。`Implemented` 由开发者确认“已实现”，`Verified` 表示需求实际验收，不能因社区沉默而推断完成。纯 Bug 修复仍使用 `Fixed / Verified`；**不要把建议状态写成 Fixed**。

自动 GitHub 创建规则：**证据充分且通过项目策略阈值**的新需求可创建带 `enhancement` 等标签的 GitHub Issue；低质量、互相矛盾或重复的需求保留为本地 `candidate`。新增相同需求只更新已有建议统计；有实质性新使用场景/约束变化时才批量更新 GitHub，避免每条群消息都发评论。已同步建议在 GitHub 中的工作流状态依旧以 GitHub 为权威；本地状态应使用显式映射与冲突审计，不把 GitHub `closed` 一律解释为 `implemented`（也可能是 `declined`）。远端创建/更新沿用 v0.4 的 `external_operations` 和 unknown/reconcile 状态机。

`SuggestionActionRequestV1` 使用身份验证、一次性令牌、`expectedVersion` 乐观锁和审计；Agent 仅能提出建议状态变化，不能冒充开发者自动接受/拒绝产品决策。`Details` 对建议和 Bug 均返回逐条原文。QQ 建议卡按钮：`Details / Accept / Planned / Implemented / Decline`，根据当前状态显示允许的动作；按钮只是命令入口，后台鉴权后修改。

### 4.7 开发者交互动作与详情查询（v0.3 新增）

QQ **半日报统一使用 Markdown + Keyboard**（不再默认发送 ARK 23）；单 Bug 与建议的 Markdown + Keyboard 仅在开发者主动查询/点击时回复，P0 Bug 可单独主动即时告警。渲染属于 QQ DeliveryPlugin，核心只给出结构化数据，不依赖 QQ 模板。按钮可触发 `Fixed`、`Investigating`、`Details`、`Next/Previous` 等操作；真实权限与回调需在当前账号测试。

- `Details` 是**只读查询**：经过开发者身份验证后，QQ 私聊分页返回玩家原文（建议每页 3 条），附平台与时间；大批量内容可转 Web 受控详情页。不得用 LLM 将原文改写、翻译或省略为“原文”。
- `Fixed`、`Investigating`、`Reopen` 等 Bug 命令进入 `IssueActionService`；`Accept`、`Planned`、`Implemented`、`Decline` 等建议命令进入 `SuggestionActionService`，检查 `actorRef`、授权、一次性 token/重放防护、`expectedVersion` 乐观锁和审计；不通过 LLM 自主执行状态写入。
- QQ `INTERACTION_CREATE` 回调应尽快确认，数据库查询/发送长消息异步处理。`visited_label` 仅是客户端展示，不代表成功更新；发送状态须以 Domain/GitHub 的真实结果为准。
- Web 控制台、未来 Discord 交互共用 `IssueActionService` / `SuggestionActionService`，不复制平台状态机。

### 4.8 半日报改为 Markdown + Keyboard（三入口，v0.6）

**规范性决策**：每日北京时间 **18:00、次日 00:00** 的 QQ 私聊半日报，默认使用 `msg_type=2` Markdown 消息并附带一行 3 个 Keyboard 按钮。**ARK 23 不再用于默认半日报。** 这是一项 Delivery 层渲染策略变更；v0.8 另补齐 ReportV2 v2.1 快照元数据，不改变 SourcePlugin v1。

按顺序固定显示三个按钮：

| 按钮标签 | `section` | QQ 内操作 | 范围 |
|---|---|---|---|
| `查看 Bug` | `bugs` | 回复本窗口 Bug 列表，选择条目后展示所有关联玩家原文 | 本份半日报涉及的 Bug（含本窗口新反馈的旧 Bug） |
| `查看建议` | `suggestions` | 回复本窗口建议列表，选择条目后展示玩家原文 | 本份半日报涉及的建议（含新增反馈的已有建议） |
| `查看 Steam 差评` | `steam_negative_reviews` | 直接回复该窗口采集到的差评原文摘录、时间和 Steam 原帖链接 | 采集于窗口 `[start,end)` 且评价为负面的 Steam Review，包括该窗口内的编辑更新，按独立 Review 去重显示 |

默认列表页 3 条，支持 `下一页`、`上一页`、`Details`。点击属于 **只读查询**：不重新运行 LLM、不调用 GitHub 写接口。Bug/建议的详情仍能使用 `Fixed`、`Investigating` 或 `Accept`、`Planned` 等操作按钮，但这些写操作必须经过各自 Domain Service、审计和版本检查。Steam 差评保留采集到的原文，不进行 AI 改写；如果无差评则明确返回“本统计窗口未采集到新增/更新的 Steam 差评”，并说明采集覆盖率，而不是笼统断言没有差评。

**半日报 Markdown 模板（数据为演示值，实际渲染使用结构化 ReportV2）：**

```markdown
# 🎮 游戏社区反馈半日报
**统计时间：** 2026-11-02 00:00—18:00（北京时间）

## 🐛 Bug
- 新增 Bug 反馈：8 条（涉及 5 个 Bug）
- P1：多人联机加载崩溃，新增 3 条反馈

## 💡 玩家建议
- 新增建议反馈：12 条（涉及 7 项建议）
- 热门：自定义手柄键位、断线自动重连

## 👎 Steam 差评
- 本窗口新增/更新差评：4 条
- 主要关注：联机稳定性、启动兼容性

## 📡 采集状态
- QQ / Discord 正常；Steam 讨论区部分受限
- 待分析：2 条（统计可能仍有修订）

[下方 Keyboard：查看 Bug | 查看建议 | 查看 Steam 差评]
```

第三方平台 QQ Markdown 支持程度及 Keyboard 渲染必须通过当前 Bot 账号实测；模板中的方括号提示仅为设计示例，**不作为正文发送**。正式消息的操作按钮由 QQ DeliveryPlugin 转换到平台 Keyboard 字段；Agent Core 仅提供抽象 `ReportPresentationV1`，不携带 QQ 平台 SDK 类型。

**回调协议**：用户点击按钮 → QQ `INTERACTION_CREATE` (`type=11`, `scene=c2c`, `data.resolved.button_data`) → QQ 插件验证已绑定开发者 OpenID、消息对应 reportId 以及操作 token → Host `ReportNavigationService.openSection(...)` → 读取固定报告快照及授权证据 → 异步发送 QQ 私聊分页结果。必须及时调用官方互动响应接口确认点击。`button_data` 只能存放短时有效的不透明操作令牌或经过验证的签名数据，不能把任意 SQL、文件路径、LLM 指令或未验证的 Issue ID 当作可信命令。

**读操作和可靠性**：报告派发后，按钮采用报告 ID + 修订版本对应的**稳定快照**查询，避免晚到数据导致翻页跳项；修订版应有明确入口或提示。回调 `(provider, interaction_id)` 幂等去重，同一点击不会重复发送多个结果。原文仅发往已绑定的开发者私聊；不得向玩家群回传。长文本按 QQ 字数上限截断显示并提供分页/受控 Web 全文链接；多条反馈原文不得被 LLM 汇总替代。

**降级行为**：Keyboard 无法使用时发送 Markdown 正文，并提示私聊命令 `/bugs`、`/suggestions`、`/steam-negative`；Markdown 本身不可用时降级纯文本。任何一次主动消息发送结果不明，仍遵循 v0.4 `unknown` / 不盲目重试规定。Web 归档永远是独立的稳定保底，不因 QQ 端错误而缺失。

**测试新增**：三个按钮顺序/标签/section 一一匹配；跨项目 reportId 拒绝；未经授权 OpenID 拒绝；过期 token 拒绝；重复 interaction 不重复回复；空 Steam 差评集正确返回；分页跨报告修订不混合；纯文本/命令降级；Markdown 与按钮发送失败正确写入 delivery 状态。


### 4.9 通知分流策略与 P0 实时路径（v0.7）

**强制规则：仅 `defect` 类型且 Issue 经领域服务确认 `severity=P0` 时允许 `p0_realtime`。** `P1/P2/P3/unknown` Bug、Steam 差评、玩家建议统一 `digest_only`；不因来源、反馈数量、GitHub Issue 创建或状态更新而触发额外即时 QQ 推送。Steam 差评如包含严重 Bug 线索，可作为 P0 Bug 的证据，但**不能直接凭差评本身发送告警**。

`urgent_candidate` 只代表**跳过正常批处理进入快速调查**，不等于 P0；评估和持续采集解耦。P0 与非 P0 路由由 `NotificationPolicyV1` 独立服务实施，模型仅建议等级，必须提交可追溯证据并经领域规则检查。领域服务对 P0 升级/降级写入审计。

```text
source event -> durable ingress -> lightweight filter
  ├─ normal -> feedback buffer -> agent triage -> Issue/Suggestion -> digest_only
  └─ urgent_candidate -> fast triage -> P0 evidence verification
                                     ├─ P0 defect -> durable P0 incident + alert outbox -> QQ C2C now
                                     └─ not confirmed P0 -> digest_only / rapid manual review
```

**防刷屏**：按 `(incidentId,alertGeneration,recipientRef)` 生成投递幂等键；同一 P0 的重复反馈持续关联原文但不再主动推送。只有有证据的重大变化、确认复发或开发者明确要求重告警时才创建新代际；已修复后复发应新开 incident。P0 通知与报告队列隔离、高优先级处理，不使用 18:00/00:00 触发器。用户明确点击 `Details` 等按钮产生的被动回复不是主动通知，不受此规则禁止。

P0 实时投递严格遵循 `external_operations`：成功为 `accepted`、权限失败 `blocked`、超时或崩溃为 `unknown`；未知状态不得盲目重发。Web 控制台显示独立的 P0 告警和投递状态；QQ 不可用仍归档。

**半日报仍汇总全部反馈（包含此前已实时告警的 P0）**，可用 `已实时告警` 标识和发送状态；不能在日报中剔除 P0，也不能在窗口截止后因迟到的非 P0 结果额外补发独立 QQ 消息。报告底部固定 `查看 Bug / 查看建议 / 查看 Steam 差评`，保持 v0.6 的 Markdown + Keyboard 规范。

详见 [`docs/NOTIFICATION-POLICY.md`](./docs/NOTIFICATION-POLICY.md)、[`notifications.default.json`](./notifications.default.json)、`P0AlertV1` 与 `P0AlertDeliveryPluginV1`。扩展接口**不修改**旧 `DeliveryPluginV1.send(DeliveryRequestV1)` 方法签名，且不假设全部发送插件支持 P0 告警。

**P0 告警 Markdown 示例（虚构数据）**：

```markdown
# 🚨 P0 · 严重 Bug 告警
**BUG-0042：更新后存档可能不可恢复**

- 来源：QQ群 / Steam
- 首次发现：17:24
- 证据：3 条独立反馈（已保存原文）
- 现状：等待开发者确认修复

请尽快查看证据并排查。
```

QQ 侧可附 `Details`、`Investigating`、`Fixed` 按钮；实际 UI 可用性须通过 QQ 官方账号验证，交互时沿用身份授权与幂等机制。**这类 P0 告警不包含非 P0 Bug/差评/建议的独立即时发送。**

### 4.10 报告修订快照与 GitHub 单一映射（v0.8，规范性）

**报告主键**：`reportId` 在同一项目的同一时间窗口内稳定；`revision` 自 1 单调递增，`(reportId,revision)` 对应**唯一不可变**的 ReportV2 v2.1 快照。`snapshotCutoffAt` 是 Host 的数据观察截止时间；`generatedAt` 为构建时刻；修订版提供 `supersedesRevision=revision-1`。每次修订新建版本，不更新旧数据。QQ 按钮和 Web 快照页面永远按按钮签发时固定的 `(reportId,revision,section)` 读取；当修订已发布，可以提示更新版，但不自动跳转，否则翻页会混合不同版本。

**固定成员**：`report_snapshot_entries` 固定 Bug/建议列表成员、排序和当时的展示字段；不能在点击按钮时查询当前 Issue 最新状态来重建报告列表（可额外标注“当前状态已变化”）。Steam 差评成员使用 `report_steam_negative_reviews` + `report_steam_review_trigger_events`，并在 `ReportV2.steamNegativeReviews[]` 明示对应的 `sourceId + reviewExternalId`、Host `evidenceEventId`、窗口内 `triggerEventIds`、`observedAt/occurredAt`、负面态及原帖链接。`evidenceEventId` 始终引用不可变 `source_events.event_id`，原文通过这个事件按权限读取，不能去 Steam 实时页面获取后假装为旧快照原文。

**Steam 选择规则**：只考虑 `received_at` 属于报告 `[startInclusive,endExclusive)` 的 Steam review 新建/更新事件；按 `(sourceId, reviewExternalId)` 去重；在 `snapshotCutoffAt` 之前可观察到的最新 Review 版本上判断是否为差评。若对应 Review 的最后可观察版本已改为好评，不在本窗口的差评成员中；更新为差评则进入。展示版本可对应窗口事件或同 Review 更晚但在截止前的事件，`triggerEventIds` 必须至少包含一个本窗口触发事件；所有引用必须属于同一项目/来源/Review。显示按窗口最后收到时间及稳定 Review ID 排序，原文保真。只有恰好一个成员对应一个来源 Review。晚到或重分析导致变化时创建修订版本，绝不动态修改已发报告。

**写入事务与封存**：Host 在一次事务中写入 `report_revisions`、`report_snapshot_entries`、Steam 成员及其触发事件，验证 JSON 与映射表成员完全一致（包含 source review 关系、负面态、触发事件确在窗口内），再插入 `report_revision_seals` 及报告投递 Outbox 并提交。外部查询与推送**只读取已封存（SEALED）的修订**；封存后 SQL 触发器禁止成员增删改及补充触发事件，修订只能通过新 revision 实现。`ReportPresentationV1.revision`、发送 `reportRevision` 和报告修订一致；不一致拒绝。历史 `schemaVersion=2.0` 仅作只读 legacy 报告；无真实快照成员的数据禁止自动拼装历史 Steam 差评，按钮只能说明历史证据不可用或跳转可信已存档内容。

**GitHub 单一权威**：v0.5 migration 002 已创建并回填 `external_work_links`（`work_kind='defect'|'suggestion'`），它是**唯一读写**映射表。`external_issue_links` 是 v0.4 历史只读表（004 migration 安装拒绝写入的触发器），后续恢复、创建成功落账、Webhook 同步、修复状态更新必须统一用 `external_work_links`。GitHub 未知创建结果对账成功时，在同一事务插入/检查该映射，并把 `external_operations` 置为 `succeeded`；遇到重复冲突进入 `manual_review`，不得写旧表绕过唯一性。

**证据区间**：`feedback_item_evidence.span_start/span_end` 允许同时为 NULL，或同时非 NULL 且满足 `start>=0`、`end>start`（UTF-16 半开区间 `[start,end)`）。只填一端必须失败。SQLite 通过 v0.8 migration 004 重建表加 CHECK；既有非法行会使迁移失败并整体回滚，需先审计和修复数据，不能无声丢弃。

## 5. 持久化、调度与恢复

### 5.1 建议数据库对象

| 表 | 主数据 | 关键约束 |
|---|---|---|
| `projects` | 游戏与项目设置 | `id` 唯一 |
| `sources` | 已启用来源和采集覆盖率 | `(project_id, platform, external_id)` 唯一 |
| `source_events` | CloudEvent 原始历史 + Host 内部事件 ID | `event_id` PK, `(source_uri,external_event_id)` UNIQUE |
| `source_objects` | 来源对象最新状态投影 | `(source_id, external_id)` 唯一 |
| `sync_cursors` | 增量同步断点 | `source_id` 唯一 |
| `outbox` | 待转为领域任务的事件 | `(event_pk, handler_version)` 唯一 |
| `admission_decisions` | 初筛结果、模型/规则版本、审计原因 | `(event_pk, policy_version)` 唯一 |
| `conversation_segments` | 会话片段、聚合边界、revision、flush 时间 | `(source_id, segment_key, revision)` 唯一 |
| `segment_events` | 片段上下文、候选原始事件引用 | `(segment_id, event_pk, role)` 唯一 |
| `feedback_batches` | 持久批次、flush 原因、策略版本 | `batch_id` 与 `idempotency_key` 唯一 |
| `batch_events` | 批次候选/上下文事件映射 | `(batch_id, event_pk, role)` 唯一 |
| `jobs` | Agent 持久任务与租约 | `idempotency_key` 唯一 |
| `agent_runs` | Worker 执行日志、模型与提示词版本 | 关联 `job_id` |
| `triage_extractions` | 每次批次多意图抽取的持久结果 | `(batch_id, pipeline_version, revision)` 唯一 |
| `feedback_items` | 独立 Bug 或建议项（允许一条原始消息对应多个） | `(triage_id, extraction_index)` 唯一 |
| `feedback_item_evidence` | 项目与原始事件多对多对应，含原文锚点 | `(feedback_item_id, evidence_index)` 唯一 |
| `feedback` | v0.4 旧版结构化记录，只读迁移视图 | 新写入改用 `feedback_items` |
| `issues` | Bug 问题档案 | 项目内 Issue ID 唯一 |
| `suggestions` | 玩家需求档案及独立状态流转 | `suggestion_id` 唯一 |
| `suggestion_feedback_items` | 建议与多个独立反馈项目关联 | `(suggestion_id, feedback_item_id)` 唯一 |
| `suggestion_status_history` | 建议状态修改与审计 | `action_id` 唯一 |
| `issue_feedback` | 问题与证据关联 | 复合主键 |
| `issue_history` | 合并、拆分、状态、优先级操作 | 不可变审计记录 |
| `external_issue_links` | v0.4 旧 Bug ↔ GitHub 映射（迁移输入） | v0.5 新写入改用 `external_work_links` |
| `external_work_links` | Bug / 建议两类工单 ↔ GitHub 映射 | `(provider,repository,external_issue_id)` 唯一 |
| `github_sync_outbox` | 结构化 Issue 更新、合并与对账 | 幂等键唯一；保留上次同步状态 |
| `external_operations` | GitHub/QQ 写操作意图、尝试、结果及对账 | 本地操作键唯一，支持 unknown/reconciling/manual_review |
| `issue_actions` | QQ/Web 开发者按钮操作与防重放 | `(source, interaction_id)` 唯一 |
| `embeddings` | 文本向量与嵌入模型版本 | `(entity_id, model_version)` 唯一 |
| `report_revisions` | 唯一的不可变报告版本内容、窗口、覆盖情况 | `(report_id,revision)` 主键；`(project_id, window_start, window_end,revision)` 唯一 |
| `report_snapshot_entries` | 本修订 Bug、建议列表的固定成员及展示摘要 | `(report_id,revision,section,ordinal)` 唯一 |
| `report_steam_negative_reviews` | 本修订 Steam 差评成员、选定原始事件版本 | `(report_id,revision,source_id,review_external_id)` 唯一 |
| `report_steam_review_trigger_events` | 差评入选触发事件（新增/更新） | `(report_id,revision,source_id,review_external_id,event_id)` 唯一 |
| `report_revision_seals` | 已完成校验及提交的报告修订封存标识 | `(report_id,revision)` 唯一；封存后不可追加成员 |
| `deliveries` | 半日报 QQ 通知计划与结果 | `(report_id, channel, recipient_ref)` 唯一 |
| `p0_incidents` | 同一活跃 P0 事件的跨消息聚合身份 | 每个项目及 Issue 最多一个 active incident |
| `p0_alerts` | P0 实时告警及证据快照 | `(incident_id,alert_generation)` 唯一 |
| `p0_alert_deliveries` | P0 QQ 实时推送意图及结果 | `(alert_id,channel,recipient_ref)` 唯一，引用 `external_operations` |
| `audit_logs` | 管理员与系统关键操作 | 仅追加 |

**SQLite**：使用 WAL、Foreign Keys、busy timeout；单机写入经任务队列串行化或有界并发。原始事件和 checkpoint 提交必须在同一事务。**Admission、Segment 和 Batch 状态也必须持久化**，模型调用只能发生在事务提交后；`feedback_batches` 的入库与对应 job/outbox 提交必须原子化。多实例部署再迁移 PostgreSQL；第一版不承诺多个进程共享 SQLite 写入。

### 5.2 Job 状态与失败处理

`pending → leased → running → completed`；失败时 `retry_wait`，超预算后 `dead_letter`；允许 `cancelled`。

- Worker 领取任务后设置有限期租约，运行时续租；租约过期可以重新领取。
- 副作用操作必须有本地幂等键；但本地幂等不等于远端幂等。**不能承诺所有外部 POST 具备 exactly-once 效果**：对于结果未知的非幂等请求，必须对账或人工确认，不能直接至少一次重发。
- 模型超时、502/504、限流退避重试并设上限；不重复新增同一个 Bug。
- 崩溃恢复按照 `outbox` 和 `jobs` 扫描，不依赖内存计时器。
- 恢复后可修复 `received-but-not-analyzed` 的 backlog，报告里注明未完成的分析量。
- 扫描超过 quiet/maxWait 截止时间但尚未 flush 的 `conversation_segments`，确定性重建批次；事件重放不可重复计算反馈数量。
- 通过 `batchId + classifierVersion` 等固定幂等键避免本地重复领域操作；GitHub 创建还必须使用可对账的远端关联标记与外部操作状态机，详见 §5.3。


### 5.3 对外副作用：GitHub / QQ 结果未知时的恢复（v0.4 新增）

**强制规则：本地 `idempotencyKey` 不保证第三方幂等。** 所有外部写入先在本地 `external_operations` 持久化意图，状态：

`prepared → in_flight → succeeded | blocked | unknown`；`unknown → reconciling → succeeded | unknown | manual_review`。仅明确未执行或服务端承诺幂等时才允许 `safe_retry → in_flight`。

**GitHub Issue 创建**：同一内部 Issue / repository 的创建操作先写本地唯一键，再 POST。Issue 正文加入不可泄露隐私的关联标记（如 `<!-- superagent-issue:BUG-0042; op:... -->`）。若服务端创建成功但本地保存结果前崩溃，恢复进程通过列出该仓库的全部状态 Issues 并逐个核对关联标记，找到了才写 `external_work_links`。GitHub REST 创建接口不能假定支持 `Idempotency-Key` 请求头；GitHub 搜索索引也不能充当立即可读的事务证明。结果长期不明时停在 `manual_review`，**不自动重发 POST**。

**GitHub PATCH / 评论**：更新前先检查当前远端状态，重试前复查目标字段并仅更新 Agent 管理区；创建评论和创建 Issue 一样需要标记与查找，不能盲目重复评论。

**QQ 单聊发送**：收到确定的成功响应 => `accepted`（平台受理，不等于已读）；确定权限拒绝 => `blocked`；发送超时、连接重置、Worker 崩溃 => `unknown`。除非平台明确提供可用的按请求 ID 对账/幂等机制，不得自动重发；Web 保留报告并提示开发者手动重试可能重复发送。详细协议与故障注入在 [`docs/EXTERNAL-WRITE-RECOVERY.md`](./docs/EXTERNAL-WRITE-RECOVERY.md)。

`DeliveryResultV1` 新增 `unknown`，`ExternalOperationV1`/`ReconciliationDecisionV1` 单独建模；不将已提交网络请求的超时误当作 `retryable`。

### 5.4 反馈报告调度

- 项目默认时区：`Asia/Shanghai`；每日两个固定触发点：`18:00`、`00:00`（午夜 00:00 属于新的一天）。
- 报告窗口按**上一次计划触发时刻至本次计划触发时刻**划定，互不重叠：
  - `18:00` 生成 `[当日00:00, 当日18:00)` 的报告，覆盖 18 小时。
  - `00:00` 生成 `[前一日18:00, 当日00:00)` 的报告，覆盖 6 小时。
- **每天两次 ≠ 每隔 12 小时**：不可使用 `setInterval(12h)` 或每 12 小时的 cron 表达式。采用项目时区的固定日历时刻触发，保证重启与错过触发后可以补生成对应窗口。
- 具体计划定义保存在 Host 的报告调度配置中；这不属于任何 Source/Delivery 插件的责任，且不改变中间层 Agent API。
- 触发时先登记窗口任务（幂等键 `projectId:windowStart:windowEnd`），报告生成允许固定宽限期，例如 3 分钟；仅影响生成/投递时间，不改变统计边界。
- 每个窗口有唯一 `report_key`，同一窗口重试不创建重复“初版报告”。
- 统计按 `received_at ∈ [start,end)`；允许生成前固定宽限期（例如 3 分钟），但不改变统计窗口。
- 生成时包含 `pendingAnalysis`、每个来源的 `coverage`、所有重点 Bug 与玩家建议的证据链接或事件 ID。v0.5 新报告使用 `ReportV2`，独立统计 `newDefectItems` / `newSuggestionItems`、`uniqueDefects` / `uniqueSuggestions`；一条原文同时提出两项诉求时可形成两个反馈项，但只算一条来源消息。
- 当批次仍在排队或正在分析时，报告明确标注待处理条数与**统计结果可能不完整**；迟到分析结果可修订报告。
- 对于迟到分析结果，新增**修订版报告**并保留历史版本，不静默改写已发送的内容。
- 报告保存和发送是两个事务：`report.generated` → `delivery.requested`；QQ 私聊失败不影响归档。
- **P0 已实时发送仍进入半日报**，且要注明实时告警状态；P0 投递不会消费掉报告窗口的事件。**非 P0 禁止单项即时推送**，包括 GitHub 自动创建/更新造成的状态变更。

## 6. Web Admin API（与 Agent Core API 分离）

HTTP API 统一前缀 `/api/v1`，供经过身份认证的 Web 控制台调用；插件不使用此 API 提交事件。

P0 告警查询可扩展 `GET /alerts/p0` 和 `GET /alerts/p0/{id}`；只能在管理员授权下查看原文与投递状态。

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/projects` | 获取有权访问的项目 |
| `GET` | `/sources` | 来源列表、覆盖率、同步状态 |
| `POST` | `/sources/{id}/probe` | 权限与能力检测 |
| `GET` | `/events` | 原始事件检索（受隐私授权限制） |
| `GET` | `/feedback` | 分页查询结构化反馈项，支持 `kind` / `category` |
| `GET` | `/suggestions` | 建议列表、热度、状态及来源 |
| `GET` | `/suggestions/{id}` | 建议详情、合并关系、GitHub 映射 |
| `GET` | `/suggestions/{id}/evidence` | 建议的玩家原文分页 |
| `POST` | `/suggestions/{id}/actions` | 鉴权后修改建议状态，版本与幂等检查 |
| `POST` | `/suggestions/merge` | 合并同一需求，保留所有反馈项 |
| `POST` | `/suggestions/{id}/split` | 拆分错聚类需求 |
| `GET` | `/issues` | Bug Issue 搜索与过滤 |
| `GET` | `/issues/{id}` | 问题详情与证据 |
| `GET` | `/issues/{id}/evidence?cursor=...` | 分页查询可见的玩家原文 |
| `POST` | `/issues/{id}/actions` | 授权开发者状态操作，强制幂等键与版本检查 |
| `GET` | `/batches` | 批处理队列、大小、flush 原因及滞后 |
| `PATCH` | `/issues/{id}` | 人工编辑，要求版本号乐观锁 |
| `POST` | `/issues/merge` | 合并问题并保留审计历史 |
| `POST` | `/issues/{id}/split` | 拆分错误聚类 |
| `GET` | `/reports` | 反馈报告历史 |
| `GET` | `/reports/{id}` | 完整报告 |
| `POST` | `/reports/{id}/deliveries` | 人工重试投递（受授权） |
| `GET` | `/jobs` | 队列与失败任务 |
| `GET` | `/runs/{id}` | Agent 执行轨迹 |
| `GET` | `/stream` | SSE 订阅任务、报告与来源健康变更 |

失败响应统一：

```json
{
  "error": {
    "code": "SOURCE_PERMISSION_DENIED",
    "message": "Bot cannot read all group messages",
    "retryable": false,
    "traceId": "tr-example-001"
  }
}
```

写操作必须检查用户授权、CSRF（Cookie 登录时）、资源归属与审计；服务只在受信网络监听或通过认证反向代理公开。

## 7. 项目工程布局

```text
superagent/
├── apps/
│   ├── server/                # Fastify + Host + Agent Runtime + 调度进程
│   └── web/                   # React + Vite 控制台
├── packages/
│   ├── contracts/             # 纯类型 + JSON Schema + fixtures，最优先冻结
│   ├── plugin-sdk/            # SourcePlugin/DeliveryPlugin/Host SDK
│   ├── plugin-host/           # 插件加载、配置、健康、权限与生命周期
│   ├── ingress/               # 事件验证、幂等、事务、outbox
│   ├── agent-core/            # Router、Scheduler、JobQueue、WorkerPool
│   ├── feedback-buffer/       # Admission、Segmenter、AdaptiveBatcher、FlushPolicy
│   ├── agent-workers/         # triage / retrieve / deduplicate / prioritize
│   ├── domain/                # Issue、Feedback、Evidence、Report 领域服务
│   ├── memory/                # 检索、embedding、历史关联
│   ├── issue-tracker/         # 独立 GitHub Provider + 同步 Outbox
│   ├── issue-actions/         # 授权开发者交互动作及审计
│   ├── llm/                   # OpenAI-compatible provider + Schema 校验
│   ├── persistence/           # SQLite migrations、repositories
│   ├── reporting/             # 反馈报告生成与修订
│   ├── renderers/             # HTML、Markdown、纯文本平台投影（ARK 非默认兼容选项）
│   ├── delivery/              # 通知任务与幂等发送管理
│   ├── connectors/
│   │   ├── qq-official/
│   │   ├── discord/
│   │   ├── steam-reviews/
│   │   └── steam-discussions/
│   └── delivery-plugins/
│       └── qq-c2c/
├── config/
│   ├── reporting.default.json
│   └── batching.default.json
├── docs/
│   ├── ARCHITECTURE.md
│   ├── API-CONTRACTS.md
│   ├── PLUGIN-DEVELOPMENT.md
│   └── ADR/
├── tests/
│   ├── contract/
│   ├── fixtures/
│   ├── integration/
│   └── fault-injection/
├── pnpm-workspace.yaml
└── docker-compose.yml
```

**依赖限制（强制 CI 校验）**：`contracts` 不可依赖任何其他业务包；`agent-core` 不可依赖 `connectors`；`domain` 不可依赖平台 SDK；`connectors` 不可读取数据库 repositories。插件通过 SDK Host 接口工作。

## 8. 安全、数据治理与平台差异

- QQ 官方机器人优先；必须实际验证全量群消息事件、指定群授权、C2C 私聊事件、主动消息权限与 Markdown+Keyboard 的回调可用性。公开文档中的 API 存在不等于某个账号已获授权。
- 玩家群消息只读；开发者 QQ 私聊仅作为**受控通知与查询渠道**。绝不允许 Agent 自发向群发言。
- 高流量时必须执行存储配额、合法保留策略和可审计的处理退化策略；不得将隐私敏感的上下文大量复制进模型提示词。
- Discord 需要按官方要求申请并授权消息内容访问；只订阅明确配置的频道。
- Steam Reviews 使用当前官方可用的评论读取能力；讨论区若缺乏可用官方 API，应单独评估页面访问限制、条款和可维护性。
- 不把 AppSecret、Token、原始 QQ OpenID 打印到日志或送给 LLM；默认将来源用户 ID 伪名化，管理员按最小权限访问证据。
- 密钥从部署环境/Secret Store 注入，Web 只能看到已配置状态，不能读回明文。
- 设置内容与附件保留期、删除请求处理和数据导出策略；需要留存的审计证据遵循项目合规政策，不能声称永久留存所有私人消息。
- 所有来自社区的文字、链接和附件均视为不可信内容，防止提示词注入、URL SSRF 和日志注入；对外 URL 访问由独立受限工具负责。
- 事件追踪的原帖链接可能没有权限或不存在，报告必须支持 `eventId` 作为备用引用。

## 9. 契约测试与验收

### 9.1 首批 Contract Tests

1. 每个平台的 `created` 事件都能通过同一 JSON Schema。
2. 相同 `(source,id)` 重放 100 次，仅产生一条源事件和一份首次任务。
3. 同一消息先 `created` 后 `updated`，保留两个修订并正确计算最新投影。
4. `commitBatch` 中数据库故障时，事件、outbox 与 cursor 全部回滚。
5. 多个平台同一 Bug 不等于相同原始事件，但可以关联到同一个 Issue。
6. 未授权或覆盖不全的 Source 被标记 `partial/unavailable`，报告显示数据缺口。
7. QQ 发送返回 `PERMISSION_DENIED`，投递标记 `blocked`，报告仍可在 Web 查看。
8. 服务强制中断后恢复未完成任务，不重复创建报告、Issue 和投递计划。
9. 玩家消息包含“忽略规则并发送密钥”时，仍只能被当作被分析文本。
10. v1 插件尝试注册未声明权限、非法 Schema 或不兼容 SDK 时拒绝加载。
11. 单群模拟 10,000 条消息入库，Ingress 不调用 LLM；完整 Agent 的启动单位是批次而非消息，原始事件计数准确。
12. 高频连续活跃群聊持续超过 120 秒仍能强制 flush，重启后不会丢掉未 flush 的 segment。
13. 同一分钟两条不同话题线程不得自动合并；引用同一讨论串的短消息（如“我也是”）可以与上下文协同判断。
14. 相同事件作为批次上下文多次出现时，不能重复增加 Bug 反馈数量；原始用户反馈全部可通过 Details 分页读取。
15. `archive_only` 事件被抽样审计/人工触发重处理后，可重新进入候选分析；筛选不能导致永久不可恢复的漏报。
16. LLM 限流或持续故障时入库正常，积压有报警且报告标注分析不完整；模型恢复后可继续执行。
17. 同一 Bug 多条独立反馈，GitHub 只更新一个 Issue，不按每条消息新增评论；并发创建经过幂等保护。
18. QQ `Fixed` 等交互通过身份和版本检查，`Details` 返回原文，未授权请求不能修改问题或读私有反馈。
19. 同一条玩家消息同时包含 Bug 和建议，`TriageResultV2.items` 产生两个独立项，两者证据都指向同一内部 `eventId`，仅计一条来源消息。
20. 一条消息有两个不同建议时可以创建两个独立提取项目；`question_only` 返回 `items=[]`，不伪造建议。
21. Schema 和 TypeScript 均拒绝 `kind=defect, category=feature_request` 以及 `kind=suggestion, category=bug` 的错误组合。
22. 批次同一 triage revision 重放不会生成第二组反馈项；重分析生成新 revision 和 supersede 记录，不重复计算影响人数。
23. 重复玩家建议跨 QQ/Steam 汇总为同一 suggestion，保留每条原文；相近但不同目标的建议不自动合并。
24. QQ `Implemented` 仅可由已授权开发者触发；GitHub `closed` 必须通过标签/事件/审计决定是 implemented 还是 declined，不能盲目推断。
25. 无权限发送/超时等 QQ、GitHub 外部写入仍遵循 v0.4 `unknown` 对账语义；分类 V2 不得绕过。


### 9.2 MVP 完成定义（Definition of Done）

- 至少一个 Source 在真实平台成功收事件并入库，且断线恢复与幂等测试通过。
- 至少两个不同平台的相似 Bug 或建议可被 Agent 建议关联，并能人工纠错。
- 单群高消息量下持久入库完整；无关消息不触发完整 Agent；可观测 batch queue 与模型费用。
- 每反馈报告窗口只生成一个初版，保留完整证据与覆盖率；迟到数据允许修订。
- Web 能独立查看 Bug、建议、原始证据、状态历史、报告、任务和投递失败原因。
- QQ 私聊“实际成功/权限阻塞”被真实测出并展示，不能用模拟成功替代验收。

## 10. 推荐开发顺序与待冻结决策

| 阶段 | 先做什么 | 交付物 |
|---|---|---|
| M0 | 冻结数据结构与 SDK v1 | `contracts`、JSON Schema、fixtures、契约测试 |
| M1 | Ingress + SQLite + Job Queue + Feedback Buffer | 原子入库、checkpoint、admission、持久 segment/batch、恢复 |
| M2 | QQ Source + QQ Delivery 能力验证 | 真实端到端最小闭环；权限结果归档 |
| M3 | Router/Workers/Memory + GitHub Provider | 多意图提取、Bug/建议独立匹配、创建/更新与同步 |
| M4 | Discord/Steam 插件 | 多平台事件统一接入 |
| M5 | Report + Web + Actions | 双固定时刻报告窗口、Bug/建议分栏、QQ 交互与原文查询 |
| M6 | 故障注入与安全审查 | 重连、限流、超时、重复事件、权限丢失测试 |

### 待确认但不阻碍 Core API 的细节

- QQ 平台针对当前机器人是否确实授予全量群消息与主动 C2C 发送权限。
- Steam 讨论区的合法、稳定采集方案及覆盖范围。
- 游戏数量、目标群/频道数量、单日消息规模（用于选数据库与并发配置）；根据真实数据调优批处理窗口、模型预算。
- Web 控制台是否允许多名开发者及各自不同访问权限。
- 反馈原文、附件和用户伪名的具体保留周期。

**版本变更（v0.2）：** 默认报告发送时刻修改为每日北京时间 18:00 和 00:00，统计窗口分别为 18 小时和 6 小时；不再使用每隔 12 小时的调度假设。

**版本变更（v0.3）：** 新增持久化 Feedback Buffer、轻量 admission、会话分段、动态批处理、独立的优先级队列与模型预算；补入证据驱动的 Bug 关联、GitHub Issues 自动创建/更新与开发者 QQ 交互按钮/原文分页查询。`NormalizedEventV1`、Source/Delivery Plugin v1 的现有必填字段不变；扩充 AgentTask 的合法任务类型和可选的领域扩展接口。

**最终架构结论：先冻结 `NormalizedEventV1`、`SourcePluginV1`、`DeliveryPluginV1`、`FeedbackBatchV1`、`AgentContextV1` 和持久化提交语义；平台插件统一发布消息，反馈缓冲层批量唤醒 Agent。**


**版本变更（v0.4）：** 修复四项契约缺口：

1. **事件 ID**：区分 `(source,id)` 与 Host `InternalEventId`，补齐映射和数据库唯一约束。
2. **可判别事件联合**：`NormalizedEventV1` 在 TS 使用 type→data.kind 映射，在 JSON Schema 使用 `oneOf + const + allOf` 逐一校验；新增 comment/review/thread 对称删除事件，仍属 v1 Draft 规范（正式冻结前确认）。
3. **Core 一致性**：显式导出 `AgentCoreV1` 与 `AgentRunViewV1`，相关参数统一内部 ID。
4. **外部操作恢复**：`external_operations` 状态机、GitHub correlation marker/远端对账、QQ 投递 unknown 状态及非盲目重试规则。

实现时以本包的 `agent-contracts.ts`、`schemas/normalized-event-v1.schema.json` 与外部操作恢复文档为准；本版本仍是规范草案，不是已实现的运行时。


**版本变更（v0.5）：** 多意图提取不改变 SourcePlugin 接口：新增 `TriageResultV2`（0..N items）、严格可判别 `FeedbackItemV2`、`SuggestionMatchResultV1`、`SuggestionActionRequestV1`、建议状态机，以及 `ReportV2` 双类别计数。新增 `002_feedback_items_and_suggestions.sql` 和运行时 JSON Schema / 正反例测试。v0.4 的 `TriageResultV1`、`ReportV1` 只读兼容；v0.4 `NormalizedEventV1`、`AgentCoreV1`、Source/Delivery 插件契约保持原样。

**版本变更（v0.6）：** QQ 私聊半日报默认渲染由 ARK 23 改为 Markdown + Keyboard；底部固定“查看 Bug / 查看建议 / 查看 Steam 差评”三个只读导航按钮。新增 `ReportPresentationV1`、`ReportNavigationQueryV1`、`ReportNavigationPageV1` 和 ReportNavigation JSON Schema/契约测试；`DeliveryRequestV1` 仅增加可选 `presentation` 字段，兼容旧调用方。当时的 `ReportV2` 结构、SourcePlugin API 和 AgentCoreV1 保持不变（v0.8 另补齐快照契约）。


**版本变更（v0.7）：** 规范主动 QQ 通知分流：只有确认的 P0 Bug 实时推送；其他 Bug、玩家建议与 Steam 差评均只进入 18:00/00:00 半日报。新增 `NotificationPolicyV1`、`NotificationSignalV1` / `NotificationRoutingDecisionV1`、`P0AlertV1`、`P0AlertDeliveryPluginV1`（选择性扩展，不破坏 v1 发送接口）、单独配置 `notifications.default.json`、通知路由 JSON Schema、`003_p0_alerts_and_notifications.sql` 和 P0 告警故障注入测试。P0 在半日报中仍计数，已实时告警标记不重复触发消息。QQ 半日报 Markdown + 三按钮规范保持不变。

**版本变更（v0.8）：** 映射统一为 `external_work_links`；报告 v2.1 固定 `revision/snapshotCutoffAt` 与 Bug/建议/Steam 差评成员；新增 004 migration 修复 `span_start/span_end` 成对空值约束。旧 v2.0 报告只读，不对历史差评进行无证据补全。


## v0.9 报告版本链与封存防护（规范性）

详见 `docs/REPORT-IMMUTABILITY-HARDENING-v0.9.md`。`report_series` 是逻辑报告 `reportId` 的**项目+时间窗口权威身份**；发布前先在同一事务 `INSERT report_series`（已经存在时直接读取核对、不可 `REPLACE`），随后 `INSERT report_revisions`、成员、封存和 outbox。不能对报告记录使用 `INSERT OR REPLACE`；数据库另外使用 BEFORE INSERT 守卫在 `recursive_triggers=OFF` 时拒绝破坏性 REPLACE（同时检查 PK 与其他 UNIQUE）。

`revision=1` 必须 `supersedes_revision IS NULL`；`revision>1` 必须 `supersedes_revision IS NOT NULL` 且等于 `revision-1`，上一修订必须已封存。同一 `reportId` 的所有修订必须拥有完全一致的 `projectId`、`windowStart`、`windowEnd`；同一项目+窗口不可使用另一个 `reportId`。已有违反这些条件的数据必须先审计修正，迁移直接失败，不得挑选一个身份静默覆盖。

**不可变范围仅限已发布的历史报告及其发布快照**，不限制实时 Bug / GitHub 工单状态修改。迟到数据通过新修订记录；删除请求/敏感数据合规处理应使用受控清除或脱敏流程，不能要求长期保留个人原文。
