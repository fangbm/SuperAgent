# v0.6 → v0.7 契约变更

- **行为规则**：唯一自动实时通知为证据确认后的 P0 Bug。非 P0 Bug、Steam 差评和建议只在两次半日报推送。
- **兼容**：保留 `NormalizedEventV1`、`SourcePluginV1`、`DeliveryPluginV1.send(DeliveryRequestV1)`、`AgentCoreV1`、`ReportV2` 与 3 个 Markdown/Keyboard 导航按钮。
- **新增（加法）**：通知决策可判别联合 `NotificationSignalV1` / `NotificationRoutingDecisionV1`，领域策略 `NotificationPolicyV1`，P0 证据事件 `P0AlertV1`，专属扩展 `P0AlertDeliveryPluginV1`。
- **可靠性**：P0 告警按 incident/generation/recipient 去重；重复玩家反馈不重复推送，重大变化需审计新代际，结果 `unknown` 不能盲目重发；优先队列与半日报独立。
- **持久化**：新增 `p0_incidents`、`p0_alerts`、`p0_alert_deliveries`，引用既有 `external_operations`。
- **配置与 Schema**：`notifications.default.json`、两个通知 Schema，正反例与 SQLite 唯一约束测试。
