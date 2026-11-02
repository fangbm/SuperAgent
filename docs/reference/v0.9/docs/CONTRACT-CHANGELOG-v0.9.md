# v0.8 → v0.9

- 新增 migration 005：冻结 `report_series` 身份、补充修订链非空校验及前序封存校验。
- 新增报告版本和全部成员表的 BEFORE INSERT 冲突拒绝守卫，修复默认 `recursive_triggers=OFF` 下的 `INSERT OR REPLACE` 破坏性覆盖。
- 新增回归测试：REPLACE/UPSERT 绕过、跨项目修订和跳号、历史坏数据迁移。
- `NormalizedEventV1`、Source Plugin v1、Agent Core v1、ReportV2 JSON Schema 2.1 均保持不变。此版仅强化持久化不变量。
