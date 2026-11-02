# SuperAgent Architecture & Contracts v0.9

**设计阶段规范（Draft / Contract-first），不是可部署的 Agent 程序。**

本版新增 P0 专属实时告警路径：P0 Bug 立即 QQ 私聊，其余 Bug、Steam 差评和建议仅在每日 18:00/00:00 半日报推送。此前多意图分类与 QQ Markdown 三按钮保持：一条 QQ / Discord / Steam 消息可以提取多个独立反馈项；Bug 和玩家建议分别检索、聚类、管理状态与 GitHub 同步，仍保留全部原始证据。

## 关键文件

- `SuperAgent_Development_Spec_v0.9.md`：完整开发规范，含高流量批处理、插件 API、QQ 私聊、GitHub 恢复及新建议流程。
- `agent-contracts.ts`：TypeScript 公共契约，新增 `TriageResultV2` / `FeedbackItemV2` / `SuggestionActionRequestV1` / `AgentContextV2` / `ReportV2`。
- `schemas/triage-result-v2.schema.json`：多意图抽取运行时 Schema，严格区分 defect/suggestion。
- `schemas/report-v2.schema.json`：报告分项统计 Schema。
- `migrations/001_core_id_and_external_effects.sql`：v0.4 新安装基线。
- `migrations/002_feedback_items_and_suggestions.sql`：v0.7 增量参考迁移。
- `docs/MULTI-INTENT-AND-SUGGESTIONS.md`：多意图与建议领域 ADR。
- `docs/EXTERNAL-WRITE-RECOVERY.md`：继承 v0.4 的外部写入恢复规则。
- `docs/CONTRACT-CHANGELOG-v0.7.md`：v0.4 → v0.7 改动和兼容性。
- `fixtures/*`、`tests/*`：TypeScript、JSON Schema 和 SQLite 契约验证素材。

## 运行静态验证

```bash
python tests/validate_contracts.py
python tests/validate_multi_intent.py
tsc --strict --noEmit --target es2022 --lib es2022,dom \
  agent-contracts.ts tests/types.contract.ts tests/types.multi_intent.ts
```

> 验证不包含 QQ、Steam、Discord 或 GitHub 的真实 API 联调。

## v0.7 的输出层协议

- 默认 QQ 半日报：Markdown + Keyboard，三个按钮分别为 `查看 Bug`、`查看建议`、`查看 Steam 差评`。
- 三按钮触发 `INTERACTION_CREATE` 后在 QQ 私聊中分页回复；不重新执行 LLM。Steam 差评直接查看原文。
- 原有问题详情 `Fixed`/`Investigating` 及建议 `Accept`/`Planned`/`Implemented` 按钮保持不变。
- 新增：`schemas/report-presentation-v1.schema.json`、`fixtures/report-presentation-markdown-qq.json`、`docs/QQ-REPORT-MARKDOWN-KEYBOARD.md`、`tests/validate_report_presentation.py`。

验证补充：

```bash
python tests/validate_report_presentation.py
tsc --strict --noEmit --target es2022 --lib es2022,dom agent-contracts.ts tests/types.report_presentation.ts
```

## v0.7 新增内容

- `notifications.default.json`：唯一允许即时推送的 P0 告警规则、去重、未知发送结果处理。
- `docs/NOTIFICATION-POLICY.md`：独立通知路由和 P0 incident 状态机。
- `migrations/003_p0_alerts_and_notifications.sql`：P0 事件、告警和投递历史。
- `schemas/notification-routing-decision-v1.schema.json`、`schemas/p0-alert-v1.schema.json`：通知决策与告警结构校验。
- `tests/validate_notification_policy.py`、`tests/types.notification_policy.ts`：路由、Schema 和数据库约束测试。

执行 `python tests/validate_notification_policy.py` 和 `tsc --strict --noEmit --target es2022 --lib es2022,dom agent-contracts.ts tests/types.notification_policy.ts`。

## v0.9 契约修正

- `external_work_links` 是唯一权威 GitHub 映射，修订恢复文档/主规范。
- 新 ReportV2 v2.1 固化 `revision`、`snapshotCutoffAt`、Steam 差评成员及来源事件引用；Bug 与建议导航使用固定快照。
- `004_report_snapshots_and_evidence_spans.sql` 重建证据区间 CHECK，缺少任意一端的 span 均不可写入。
- `tests/validate_v08_contracts.py` 和 `tests/types.v08.ts` 检查迁移、快照和类型。

验证：`python tests/validate_v08_contracts.py`；所有先前测试仍应通过。设计阶段文档，尚非真实平台联调。

参见 `docs/REPORT-SNAPSHOT-V2.1.md` 了解快照选择与封存；SQL 检查不能替代跨表的 Host 领域校验。

## v0.9 数据一致性补丁

- `migrations/005_report_immutability_and_revision_identity.sql`：报告身份/链校验，全部冻结表的 INSERT OR REPLACE 守卫。
- `docs/REPORT-IMMUTABILITY-HARDENING-v0.9.md`：说明报告历史快照不可变与实时问题可变的区别。
- `tests/validate_v09_snapshot_integrity.py`：SQLite 故障/绕过回归。
