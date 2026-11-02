# Contract changelog: v0.5 → v0.6

- 非破坏性变更：`DeliveryRequestV1` 新增可选 `presentation?: ReportPresentationV1`。未携带此字段的旧调用方仍可工作。
- 新增 `ReportSectionV1`、`ReportNavigationActionV1`、`ReportPresentationV1`、`ReportNavigationQueryV1`、`ReportNavigationPageV1`。
- QQ 半日报默认从 ARK 23 改为 Markdown + Keyboard，三个按钮：查看 Bug、查看建议、查看 Steam 差评。
- QA：按钮回调仅查询，不修改 Issue；三入口按 report snapshot 过滤；Steam 差评保留原文；合法/非法 Schema 校验；按钮能力不可用时提供指令降级。
- 不变：NormalizedEventV1、AgentCoreV1、SourcePluginV1、ReportV2、v0.4 外部写操作未知状态恢复语义、v0.5 多意图结构。
- 注意：插件能力和 QQ 端 UI 尚待真实授权机器人联调，不能把 Mock 结果当成实机验证。
