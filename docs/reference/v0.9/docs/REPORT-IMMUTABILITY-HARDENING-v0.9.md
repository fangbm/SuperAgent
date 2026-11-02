# v0.9 报告封存、不可变与逻辑报告身份

## 为什么需要历史快照

QQ 半日报的三个按钮固定绑定 `reportId + revision`，开发者隔天点击仍应看到发送当时的 Bug/建议/Steam 差评成员。Issue 的**实时状态**单独查询展示，不能改写历史成员和历史文本。快照错误通过新修订修正，不覆盖既有通知所指版本。

## 两类防护

1. 触发器拦截 `UPDATE`、`DELETE`，包括 `INSERT OR REPLACE` 可能造成的隐式删除（SQLite `recursive_triggers=OFF` 不执行该隐式删除的 DELETE 触发器）。新增 BEFORE INSERT 拒绝**全部会产生 UNIQUE 冲突**的报告记录，不只 PK：`report_revisions`、`report_snapshot_entries`、`report_steam_negative_reviews`、`report_steam_review_trigger_events`、`report_revision_seals` 及 `report_series`。SQLite DDL 本身不支持真正阻止数据库所有者禁用触发器/篡改模式；安全边界包括数据库文件访问控制和只由 Host 持有写连接。
2. `report_series(report_id, project_id, window_start, window_end)` 绑定同一逻辑报告的唯一项目和时间窗口。所有修订加入时核对；`revision>1` 必须明确指向 `revision-1` 并要求上版已封存。迁移预检发现历史冲突立即失败。

## 原子发布伪流程

`BEGIN IMMEDIATE` → 查询或首次创建 `report_series`（不使用 OR REPLACE） → 插入 `report_revisions` → 插入成员 → 领域校验一致性 → 封存 → 投递 outbox → COMMIT。任何错误全事务回滚。不要把已经生成的报告 JSON 当作一个可变字段去覆盖。

## 不可变 ≠ 永不删除

正常业务中报告封存后 append-only；敏感信息依法需移除时走专用管理权限、审计记录、脱敏/清除和链接失效流程，并与备份保留策略协调。

## 测试要求

`PRAGMA recursive_triggers=OFF` 下，对所有成员和封存表执行 `INSERT OR REPLACE` 并确认旧内容不被覆盖，成员数不变。再测试不同 `report_id` 引起的次级 UNIQUE 冲突、修订号大于 1 但 NULL predecessor、跨项目/跨窗口修订、越级修订和前序未封存。迁移遇到历史错误数据必须失败并保留原始数据。
