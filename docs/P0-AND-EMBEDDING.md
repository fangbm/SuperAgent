# P0 即时告警与统一入口 Embedding

本页描述 `codex/p0-and-embedding` 在已合并统一架构上的增量。配置默认关闭；未运行真实 QQ 告警发送或付费模型验收。M0 的契约、SDK、Schema、默认策略和冻结账本不变。

## 启用方式

在本地统一配置副本中增加以下顶层字段，仍通过唯一正式入口 `pnpm start --config <本地配置>` 运行：

```json
{
  "notifications": {"p0Enabled": true, "evaluationTimeoutMs": 10000},
  "embeddings": {
    "enabled": true,
    "allowExternalCalls": true,
    "baseURLEnv": "SA_EMBED_BASE_URL",
    "modelEnv": "SA_EMBED_MODEL",
    "apiKeyEnv": "SA_EMBED_API_KEY",
    "timeoutMs": 10000,
    "batchSize": 8
  }
}
```

这是字段片段，不是完整应用配置。P0 必须同时显式开启 analysis 与 allowExternalCalls，复用该模型接口；Embedding 可以单独启用，使用自己的 endpoint/model/key，与 Chat 模型配置独立。两项缺省均关闭，仅设置环境变量不会启用。无需密钥的 provider 可省略 apiKeyEnv。也可直接配置 baseURL/model；环境引用优先。生产地址要求 HTTPS，只有显式 allowLoopbackHTTP 才允许本机 HTTP。check-config 只做静态校验，启动再核对环境引用。

evaluationTimeoutMs 为 100–60000 毫秒，默认 10000；Embedding timeoutMs 同范围、默认 10000，batchSize 为 1–64、默认 8。并非每个 Chat provider 都支持 Embedding；必须使用实际支持该接口的模型和地址。

## P0 证据与通知规则

Archive 与逐消息 Admission 仍先于模型。既有 urgent_candidate 使用最长五秒的紧急合批期限；统一入口另外运行一个仅认领 priority>=100 的 AnalysisWorker，避免普通模型请求占住唯一分析循环。其结果提交到同一 Domain 后，再由 `notification.p0.evaluate` 在既有 p0_alert lane 评估。

初始自动确认策略保守限定三种影响：不可恢复的存档丢失、账号被接管、全体玩家服务中断。模型输出只是提案：Domain 要求至少两个不同来源对象、同一已关联且无需复核的当前 Bug、有效 primary 原文和逐字引文，且引文本身符合严重影响规则。存档损失还须明确不可恢复或永久，假设、愿望等不自动确认。单条证据、普通崩溃、紧急关键词、建议和差评本身均无即时发送资格。策略可能漏掉其他真实严重事件；开发者可在 Web Bug 详情核实原文后填写影响与理由，人工确认。

同一 active incident、同种影响只建一份告警；重复反馈继续归档并关联，不重发。新种类的关键影响可增加 generation；开发者“明确重新告警”也创建新代次。事件结束或 Bug 修复/忽略后关闭 incident；自动复发确认必须包含结束后新归档的当前证据，旧证据与状态重开不足以证明复发。旧告警证据、旧报告和原文锚点不改写。

告警持久化在冻结的 p0_incidents/p0_alerts/p0_alert_deliveries，新增 013 仅保存评估、影响集合和投递请求。任务、确认与发布在同一 SQLite 事务内完成；租约过期的模型结果不能发布。评估记录保留模型名、用量、提案或安全错误码，最多沿用队列三次尝试；不无限调用模型。

## QQ 投递与结果未知

`notification.p0.deliver` 复用单一 Job Queue 的高优先级 p0_alert lane，与报告 lane 分开；只有显式具备冻结 sendP0Alert 扩展的 QQ Delivery 可发送。独立循环避免半日报、普通 GitHub IO 阻塞告警。QQ Source 不持有通知决策。沿用唯一已批准开发者 C2C 绑定，插件不接触 SQLite；没有群发送路径。

发送还需 Delivery enabled=true、allowWrites=true、有效批准绑定和授权。无 Delivery、未开放写入或无扩展能力均本地归档 blocked，可在 Web 查看，不能悄悄调用普通 send。投递前重新核对绑定、授权、活动 incident 及原始告警证据。权限撤销、证据撤回或事件结束会阻止尚未发送的请求。

external_operations 在调用平台前持久认领。accepted 仅代表接口受理；超时、异常、进程崩溃和响应丢失保留 unknown，不自动重发，晚到成功也不能覆盖 unknown。只有插件明确返回 retryable 的已知安全失败允许至少 30 秒后再试，总计最多三次；QQ 的不明 HTTP 结果本身仍为 unknown。blocked/unknown 不会因为重启或重新开放权限自动补发；操作员核实后可明确重新告警，新代次可能造成重复送达，必须先核对旧状态。

Web 新增 P0 告警页，分别显示事件、代次、投递与评估状态；Bug 详情提供确认、结束、重新告警。动作复用现有开发者鉴权、CSRF、一次性绑定 token、乐观版本与证据指纹，均记审计。P0 仍进入固定半日报计数和原文索引，报告快照标注当时的接口受理/blocked/unknown 等状态，不把已受理当已读。

## Embedding 索引与降级

复用同一 HybridMemory、embedding_outbox 与 work_embeddings，独立受管理循环增量索引工作项标题和摘要。向量按模型名和文本哈希隔离；文本更新时旧向量不参与召回，晚到旧哈希结果不能覆盖新索引。相同名称对应的模型有不兼容更新时，操作员应修改 model 名称/版本，避免混用。

检索合并 FTS5/BM25 与语义排名；未启用或接口失败时返回 lexical，成功时返回 hybrid，仍暴露语义候选池截断。向量相似只生成候选，是否同一反馈继续走证据匹配，不按相似度直接合并。

接口故障保持待索引记录，所有查询与索引共享 30 秒起步、最高 15 分钟的指数冷却。失败不阻塞 M1/M3/M5；状态提供 available/unavailable、连续失败、最近成功和下次尝试时间。每次请求同时受调用者、应用退出和配置超时约束；退出等待受管理循环后关闭 SQLite。真实向量质量、跨语言召回率、大语料效果与长期吞吐尚未验收。

## 本地验证与限制

新增 tests/integration/p0-notifications.test.mjs 和 application-features.test.mjs 的 25 项测试，使用真实文件 SQLite、受控模型/Embedding HTTP 与 QQ API 双替身；覆盖统一入口、五秒紧急路径、证据/代次/复发、幂等、租约、unknown、权限、Web 鉴权和实际客户端脚本 DOM、索引与降级。完整 pnpm check 的 380 项 Node 与 6 组参考验证、pnpm test:m6 的 76 项通过；45 个冻结文件未变。DOM 测试不是可见浏览器验收，也不代表真实平台送达或模型质量。汇总见 [项目状态](PROJECT-STATUS.md)。

当前紧急 Admission 识别的存档/账号线索走五秒路径；其他严重影响仍可能先经普通合批，后续 Domain 确认不等待半日报。本实现不承诺所有措辞都能被规则及时识别。平台主动通知权限、真实送达和长稳需另外按批准预算验收。
