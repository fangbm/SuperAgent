# v0.7 → v0.8 修订记录

1. 统一 GitHub 映射：`external_work_links` 是 v0.5 迁移后唯一运行时读写表；`external_issue_links` 仅历史迁移来源。远端对账成功需与操作标记在同一事务提交。
2. 报告快照闭合：`ReportV2.schemaVersion=2.1`，强制 `revision`, `snapshotCutoffAt`, `steamNegativeReviews`，旧 `2.0` 类型只读。报告修订及跨成员的 UUID/唯一键由数据库约束。
3. 报告导航只读快照：Bug/建议固定列表，Steam 差评固定 review 身份 + 选中的 Host event ID + window trigger IDs；按 reportId + revision 查询且不能默默跳最新。
4. DB Migration 004 对反馈证据 span 加成对 NULL 与正长度约束，旧表通过事务重建；历史非法行导致整批回滚。
5. 扩展测试包括 schema、TS 类型、SQLite 正/负用例、修订版本对账和 DB 迁移失败回滚。

**兼容性**：SourcePlugin v1 / NormalizedEventV1 / AgentCoreV1 输入不变；`requestReport` 响应加 `revision`。ReportV2 写出格式升级 2.1，2.0 只读不予自动升级；交互客户端使用 v0.8 发布后新生成的快照。

6. 发布封存：`report_revision_seals` 及触发器防止已推送快照继续追加成员；读取仅限 SEALED 修订；旧 `external_issue_links` 安装只读写入保护。
