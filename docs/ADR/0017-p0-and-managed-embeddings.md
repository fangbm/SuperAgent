# ADR 0017：P0 即时告警与受管理 Embedding

2026-11-04。在统一主程序和可信插件 Registry 上补齐两项运行能力，不调整 M0 API、Core 总体结构或产品范围。

## 决策

- 在 Domain 增加保守 P0 证据策略与 append-only incident/generation 服务，模型仅提案。紧急 AnalysisWorker 仍复用既有 full_agent 任务，通知用已冻结的 notification.p0.evaluate/deliver 类型及 p0_alert lane。
- 统一应用管理独立的紧急分析、P0 评估和投递循环，复用一个 SQLite/Domain/Job Queue。scripts/p0-services.mjs 负责认领、调用、结果持久化与退出，packages/domain/src/p0.ts 负责证据和 incident 规则；不新增独立调度进程。
- QQ 通过冻结 P0AlertDeliveryPluginV1.sendP0Alert 扩展执行专用请求。没有能力就阻塞，不将 P0 伪造为报告。投递保留持久认领、绑定复查、有限已知安全重试与 unknown 屏障。
- 新增迁移 013 补充运行态，冻结 001–003 及既有迁移不变。告警、队列完成和请求入账同步事务提交，防止重启漏调度；旧不可变告警不追加修改。
- 顶层 embeddings 明确授权独立 endpoint/model/key，默认关闭。统一进程管理现有 outbox，不要求另开 worker。查询失败回退词法，故障共享冷却，文本哈希/模型隔离延续。
- Web 复用现有鉴权、CSRF 和单次令牌展示与操作 P0；半日报继续包含已告警 Bug，并保存当时投递状态。

## 边界与代价

初始 P0 自动标准仅覆盖三类严重影响，需要两个当前原文对象和规则核实。规则可能误读或漏掉真实措辞，不能替代真实质量评估；人工确认必须填写依据。已有 QQ 主动通知权限不由 probe 保证。没有真实平台发送、付费模型调用或长稳验收。无多租户、通用 Delivery 框架、Discord 社区功能或任意动态模块加载。

配置、发送不确定性及验证范围见 [运行说明](../P0-AND-EMBEDDING.md)。
