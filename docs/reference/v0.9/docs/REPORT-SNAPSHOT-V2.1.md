# ReportV2 v2.1 — 不可变报告快照（规范性）

## 1. 身份和版本

- `reportId`：一个项目+统计窗口对应的逻辑报告 ID。
- `revision`：从 1 开始；新修订必须为上一次已封存修订号 + 1。
- `schemaVersion`：新写入必须为 `2.1`；`2.0` 为只读遗留数据，不允许推断缺失成员。
- `snapshotCutoffAt`：Host 观察截止 UTC 时间，所有成员引用和汇总基于此观察状态。
- `generatedAt`：生成时刻；不等于时间窗口边界。
- `supersedesRevision`：revision>1 时是上一个修订号。

时间窗口依旧按 `received_at ∈ [startInclusive,endExclusive)` 定义，生成宽限期和后续修订不改变时间窗口；两个定时点为北京时间 18:00 和 00:00。

## 2. 成员选择

### Bug 与建议

`report_snapshot_entries` 保存每一修订涉及的 Bug 与建议的固定成员、排序、当时的展示标题和统计字段。被点击的消息不能在请求时从当前 GitHub/Issue 表重新筛出成员。可以另行查询“现在的状态”，但必须与报告时的状态显式区分。

### Steam 差评

成员身份是 `(reportId,revision,sourceId,reviewExternalId)`。一次编辑可产生多个来源事件，同一个 Steam Review 在同一快照中仅占一个列表位置。`triggerEventIds[]` 记录窗口内导致其进入统计的所有创建/更新事件；`evidenceEventId` 指向截至 `snapshotCutoffAt` 已观察到的该 Review 最新记录，必须属于同一个 `sourceId` 和 `reviewExternalId`，且 sentiment 为 negative。`originalText` 从这个不可变 Host 来源事件取出，不调用当前 Steam 页面替换历史原文。

若窗口内更新了 Steam 评论，但快照截止前的最新 Review 状态变为 positive，则不属于“窗口新增/更新差评”。无权限或覆盖率不足应标记不完整，不能当作零差评。

SQLite 约束：成员 Review 身份唯一，序号唯一；引用 event 必须同项目+同来源。**领域校验器**还须核对 external review ID、平台、事件类型、情感、窗口边界、`triggerEventIds` 和 Report JSON 之间的一致性。不能声称 SQL CHECK 单独验证了全部跨表业务语义。

## 3. 原子发布 / 封存

一个 DB transaction 必须完成：

1. 插入 `report_revisions`（schema 2.1，修订已确定）。
2. 插入 Bug/建议列表 `report_snapshot_entries` 和 Steam 成员/触发事件。
3. 校验 Report JSON 与所有成员、计数、排序及权限的完整一致性；在事务内插入 `report_revision_seals`。
4. 同一事务插入 `report.generated` Outbox；commit 后由另一流程异步创建 QQ 投递操作。

只有存在 `report_revision_seals` 的报告可被浏览/投递。触发器禁止封存后追加、修改或删除成员。更正需发布下一修订；QQ `reportId+revision` 已签发的按钮不跳向最新版本。

`report_revision_seals.content_hash` 是报告 JSON 与全部成员的规范化序列的 SHA-256，用于检查内容完整性。具体序列化标准（canonical JSON, 条目排序、UTF-8）由实现文档进一步冻结；不得对 Python/JS 的未固定 map 顺序直接计算哈希。注：当前 SQL 存在 seal 字段但**尚未实现全量规范化哈希校验器**。

## 4. QQ 导航

`ReportPresentationV1` 含 `reportId` 和 `revision`。送往 QQ 的令牌应绑定相同的 `reportId+revision+section+recipientRef`，查询 `ReportSnapshotStoreV1.getExact` 必须强制精确修订。报告缺少或历史快照无法验证时显示“原始快照不可用”，绝不通过 live Steam 数据重新构造。

## 5. 向后兼容

- 新写入仅接受 v2.1；旧 v2.0 报告可作为 Legacy 展示既存 markdown 和 counts。
- 如果无法从历史数据库验证 Steam Review 身份和事件版本，不应为旧报告补造 `steamNegativeReviews`。
- 迁移后 `external_work_links` 是唯一外部工单映射表，`external_issue_links` 只读。
- 尚未开始正式数据部署的开发环境，可以直接从 migration 001→004 建库；已有用户数据必须备份并先清理部分 NULL 的证据区间。
