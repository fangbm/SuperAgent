# M0 公共契约

基线：用户提供的 `SuperAgent_Architecture_Contracts_v0.9 (3).zip`；工程包版本 `0.1.0`。文档版本、npm 包版本与数据 `schemaVersion` 各自独立。

## 类型入口

`@superagent/contracts` 导出完整领域与 Core 类型；`@superagent/plugin-sdk` 只导出插件需要的类型。`InternalEventId` 是品牌类型，禁止直接把平台 `.id` 传入 `AgentCoreV1.accept`。该品牌是编译期边界，Host 必须在存储层落实映射与归属校验。

冻结重点：`NormalizedEventV1`、`SourcePluginV1`、`DeliveryPluginV1`、`FeedbackBatchV1`、`AgentContextV1/V2`、`AgentCoreV1`，以及报告/通知、外部操作和开发者动作的随包类型。新分析使用 `TriageResultV2`；旧分析类型仅供历史读取。新报告写出 `ReportV2` 的 `schemaVersion=2.1`，旧 `2.0` 对应 `ReportV2Legacy`，不自动补造历史成员。

## 运行时 Schema

所有 Schema 使用 JSON Schema 2020-12；`validateContract(name, unknown)` 返回可判别结果，`parseContract` 对错误抛出 `ContractValidationError`。成功时返回原对象，不进行字段删除、默认值填充或类型转换。非 JSON 值和循环对象被拒绝。生产校验使用 Ajv2020 与格式校验；诊断只包含路径、Schema 路径和规则名。

| 注册名 | 数据 |
| --- | --- |
| `normalized-event-v1` | 12 种反馈事件与 1 种来源覆盖事件的判别联合 |
| `plugin-manifest-v1` | 插件身份、配置 Schema 和权限声明 |
| `feedback-batch-v1` | 候选/上下文的内部事件 ID |
| `triage-result-v2` | 0..N 个 defect/suggestion 提取项 |
| `report-v2` | 报告 v2.1，固定修订与 Steam 成员 |
| `report-presentation-v1` | 固定三个导航动作及顺序 |
| `notification-routing-decision-v1` | P0 实时或半日报路由结果 |
| `p0-alert-v1` | 需要证据的 P0 告警 |
| `commit-result-v1` | Host 提交回执和重复事件 ID 映射 |
| `delivery-request-v1` | 报告投递请求 |
| `delivery-result-v1` | 包含 `unknown` 的平台受理结果 |
| `p0-alert-delivery-request-v1` | 独立 P0 投递请求 |
| `agent-task-v1` | 闭合的任务种类及 JSON payload |

后五份 Schema 是 M0 为现有 v0.9 类型补齐的机器可读边界，没有增加公开方法。带 `presentation` 的报告请求必须携带 `reportRevision`；旧纯文本请求仍可省略。Host 还须比较请求、presentation 和封存报告的 ID/修订是否一致。任务 payload 的各工作流结构留待对应实现阶段冻结。

为兼容 Ajv 的严格 Schema 编译，两个原 Schema 的条件分支补了外层已限定的 `array/integer` 类型注解；接受的数据范围不变。保留 `strictRequired=false`，允许分支引用父 Schema 声明的字段；其余严格模式与格式检查保持开启。

## 必须由 Host 完成的语义验证

Schema 通过不等于可以执行动作。M1 及领域服务必须检查：

- project/source/recipient 的已授权归属，manifest 的配置 Schema 合法性、SDK 版本和实际可用权限。
- 回执 accepted/duplicates 与输入次序、refs、持久事件记录的一致性。
- evidence 的真实来源、原文引文与 UTF-16 区间、跨项目隔离。
- 报告计数、窗口、固定成员、修订链与封存哈希的一致性；当前 reporting 已对报告 JSON 和成员的规范化序列计算、读取验证 SHA-256，详见 [M5 运行说明](M5-REPORTS-AND-ACTIONS.md)。
- 只有已确认的 P0 才能产生实时投递；结构正确的 P0 对象本身不是授权。
- 开发者动作的身份、版本号、重放防护和合法状态转换。

## 契约变更

`contracts.freeze.json` 固定类型、Schema、fixtures、默认配置、SDK 与参考迁移的字节哈希，CI 同时检查新增/遗漏文件。修改前记录兼容性结论与 ADR，调整包或数据版本，补正反例，随后显式更新清单。该清单用于审阅变更，不是防止仓库所有者修改文件的安全机制。
