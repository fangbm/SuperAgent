# M3 分析与同步运行说明

正式运行使用 [统一主程序](UNIFIED-APPLICATION.md) 内的 M3 循环；下述独立 worker 命令仅用于调试，不能与正式进程操作同库。当前功能/验收汇总见 [项目状态](PROJECT-STATUS.md)。

## 数据流和身份

`AnalysisWorker.tick` 只领取 `feedback.batch.triage` / `feedback.extract.v2`。领取时有持久租约，分析先写 `analysis_requests`，每次执行记录 `agent_runs`，每次新模型请求记录 `model_calls`。网络发生在事务外；最终结果、反馈项、证据、领域关联、检索索引、同步 outbox 和本地任务确认同事务提交。

一个原文可同时提取 Bug 和建议。模型不分配持久业务主键，也不能生成正式操作批准。`AgentContextV2` 只提供本项目证据、检索和变更提案，不能直接发送消息、访问平台 Token 或执行 Shell。所有模型内容均经 Schema 校验，源消息只作为不可信数据。

## 证据与计数

- 每项至少一个来自本批候选的 primary；context 不能单独创建新反馈。
- 引文必须逐字来自已持久化的正文，或 thread 的原始标题，不能跨标题/正文边界拼接。抽取和 Bug/建议匹配分别传递标题与正文，模型标题输入最多 2048 字符；正文 text 保持原样。可选 start/end 仍只指向正文的 UTF-16 区间，并与引文完全一致；标题引用不填写正文偏移。当前默认提示词要求精确引文，禁止估算偏移。QQ/Web 原文使用同一授权证据读取，显示完整标题及正文。
- 跨项目、批次外、已删除、过时 primary 均被拒绝。完全过时/删除的批次无需模型，提交空提取并协调旧活跃证据。
- 领域反馈数按不同 `(sourceId, externalId)` 计数，不称为不同玩家数。重复引文、上下文和同对象修订不会重复计数。
- 缺少证据、冲突、多个 same 候选或不确定关系保留 candidate/review，禁止自动同步。新来源命中人工 Fixed/Verified 等状态时保留人工状态并要求复核。
- 默认自动处理阈值 0.8 是项目策略初值，不是准确率。优先级分值由紧急线索和反馈数量计算，不自动判定 P0，也没有启用即时通知。
- Admission 默认对普通消息按 auditSampleRate=0.02 抽样；抽中的 audit_sample 在启用模型后也会分析。编辑过滤只跳过已有安全归档的无关前驱与当前无关文本，不能把排队的后续编辑当作前驱；实质反馈撤回、新附件和有意义的主题标题保持候选资格。

## 检索与重分析

默认 FTS5/BM25，中文使用字串分词以避免整句成为一个 token。统一正式入口通过顶层 embeddings 显式配置独立 endpoint/model/key，并管理增量索引；仅设置 SA_EMBED_* 环境变量不自动启用。调试 worker:m3 继续读取这些环境变量，但不能与正式进程同时操作同库。向量按模型版本、文本哈希保存；语义候选扫描有上限并暴露截断标记。接口失败回退 lexical，并共用故障冷却。实现与本地验证见 [运行说明](P0-AND-EMBEDDING.md)，不等于真实跨语言召回质量已验收。

每项最多取 3 个候选，向模型提供每个候选最多 5 条历史主证据，并说明截断；完整证据继续在本地留档。相似度不直接合并。Bug Matcher 和 Suggestion Matcher 使用不同的关系输出，并保存支持、冲突和缺失信息。

`reanalyze(projectId,batchId,pipelineVersion)` 创建下一修订任务。同批成功结果重复执行不会再写实体。旧结果保留，新投影原子替代。`moveFeedback`、`splitFeedback`、`mergeWorks` 是领域方法；Web 已通过 ControlPlane 和 `/api/corrections/token`、`/api/corrections` 提供移动/拆分/合并，检查 actor、项目、一次性令牌、版本、理由及审计。QQ 当前提供导航与状态动作，没有这些纠错入口。

## 模型与 worker 配置

正式入口须显式设置 analysis.enabled/allowExternalCalls；baseURL/model 可直接配置，或通过 baseURLEnv/modelEnv 引用进程环境，密钥用 apiKeyEnv 引用，应用不自动读取 .env。Steam 示例引用 SA_LLM_BASE_URL、SA_LLM_MODEL、SA_LLM_API_KEY 并已启用 M3；默认根配置关闭模型。下面的独立调试 worker 直接读取 SA_LLM_*，没有启用正式服务的作用。默认使用 JSON object 格式并在本地验证完整 Schema。HTTP 地址仅在显式开启且为 loopback 时允许，远端必须 HTTPS；不跟随重定向。

```powershell
pnpm worker:m3 --database .artifacts/local.sqlite --once
pnpm worker:m3 --database .artifacts/local.sqlite
```

正常退出由 AbortSignal 取消请求、结束循环并释放连接。超时/429/5xx 重试受任务预算和分析总调用预算约束。被强制终止的运行和未确认调用标记为中断；旧租约不能提交领域变更。未知用量保留为空，不编造 token 或费用。

`demo:m3` 使用确定性适配器，仅演示本地流转；`m3-live-analysis.mjs` 是用户授权下的真实模型验收脚本，输入仍为合成平台消息，不等于平台采集完成。

## GitHub

只有配置项目 → 私有仓库映射的合格工作条目产生 sync outbox。正式入口使用 github.enabled、allowWrites、repository 和 tokenEnv；独立 worker:m3 默认不写 GitHub，调试写入必须提供 token、仓库、--project 和 --github-write。repo 的实际 private 状态在发送前核对。

新工单写初版正文和稳定操作标记。后续反馈合并为专用机器人统计评论，之后更新该评论；不会 PATCH Issue 正文、标题或开发者标签。每次显示最多 20 个证据引用，其他原文/引用在本地保留。统计更新默认合并等待 60 秒，持续反馈不无限延后已有等待时间。

创建与评论超时、5xx、进程中断进入 unknown；全状态分页对账后唯一命中才能保存映射与 succeeded，同事务提交。多个命中、缺失权限、分页不完整或长期不可确认会保留 unknown 或转人工。只有明确未受理的失败或确认未生效的自有评论 PATCH 可进入 safe_retry；重试有上限。

GET 状态对账及经 HMAC 验证/去重的 webhook 可以更新本地工作流。Bug closed/completed 映射 Fixed，不映射 Verified；建议 closed 不直接映射 Implemented，而要求复核。回调接收函数已实现，没有部署公网 webhook 服务。

验收的 stdio 桥接使用已连接 GitHub 插件，不保存 OAuth token。其 Issue 全量列举能力不足时不使用 Search 证明“没有创建”；真实未知发送的权威恢复仍需配置 REST provider 或人工复核。

## 尚未覆盖

指定 QQ 群的普通消息、自动批处理和真实模型，以及开发者私聊/GitHub 状态闭环和 Web 显示，已有分轮真实验收；Steam 有匿名有界读取和重放证据。见 [QQ 主链路](QQ-MAINFLOW-ACCEPTANCE.md)、[M5 验收](M5-ACCEPTANCE.md) 与 [Steam 运行说明](STEAM-PUBLIC-FEEDBACK.md)。这些不代表其他群权限、Discord 实际部署权限、Steam 全历史、长期运行、生产数据保留/删除治理、真实 Embedding 质量或总体语料召回准确率已验收。
