# M3 分析与同步运行说明

## 数据流和身份

`AnalysisWorker.tick` 只领取 `feedback.batch.triage` / `feedback.extract.v2`。领取时有持久租约，分析先写 `analysis_requests`，每次执行记录 `agent_runs`，每次新模型请求记录 `model_calls`。网络发生在事务外；最终结果、反馈项、证据、领域关联、检索索引、同步 outbox 和本地任务确认同事务提交。

一个原文可同时提取 Bug 和建议。模型不分配持久业务主键，也不能生成正式操作批准。`AgentContextV2` 只提供本项目证据、检索和变更提案，不能直接发送消息、访问平台 Token 或执行 Shell。所有模型内容均经 Schema 校验，源消息只作为不可信数据。

## 证据与计数

- 每项至少一个来自本批候选的 primary；context 不能单独创建新反馈。
- 引文必须和已持久化原文逐字对应；如有 start/end，必须满足 UTF-16 区间与引文完全一致。当前默认提示词只要求精确引文，禁止估算偏移。
- 跨项目、批次外、已删除、过时 primary 均被拒绝。完全过时/删除的批次无需模型，提交空提取并协调旧活跃证据。
- 领域反馈数按不同 `(sourceId, externalId)` 计数，不称为不同玩家数。重复引文、上下文和同对象修订不会重复计数。
- 缺少证据、冲突、多个 same 候选或不确定关系保留 candidate/review，禁止自动同步。新来源命中人工 Fixed/Verified 等状态时保留人工状态并要求复核。
- 默认自动处理阈值 0.8 是项目策略初值，不是准确率。优先级分值由紧急线索和反馈数量计算，不自动判定 P0，也没有启用即时通知。

## 检索与重分析

默认 FTS5/BM25，中文使用字串分词以避免整句成为一个 token。可配置独立的 Embedding endpoint/model/key；向量按模型版本、文本哈希保存。语义候选扫描有上限并暴露截断标记。未配置向量时不声称实现了已实测的跨语言语义召回。

每项最多取 3 个候选，向模型提供每个候选最多 5 条历史主证据，并说明截断；完整证据继续在本地留档。相似度不直接合并。Bug Matcher 和 Suggestion Matcher 使用不同的关系输出，并保存支持、冲突和缺失信息。

`reanalyze(projectId,batchId,pipelineVersion)` 创建下一修订任务。同批成功结果重复执行不会再写实体。旧结果保留，新投影原子替代。开发者可通过 `moveFeedback`、`splitFeedback`、`mergeWorks` 纠正关联；这些是内部领域方法，不是已经交付的 Web/QQ 动作 API。显式授权 actor 列表、版本、理由和审计必需。

## 模型与 worker 配置

通过进程环境提供 `SA_LLM_BASE_URL`、`SA_LLM_MODEL`、`SA_LLM_API_KEY`；不会读回或保存密钥。默认使用 JSON object 格式并在本地验证完整 Schema。HTTP 地址仅在显式开启且为 loopback 时允许，远端必须 HTTPS；不跟随重定向。

```powershell
pnpm worker:m3 --database .artifacts/local.sqlite --once
pnpm worker:m3 --database .artifacts/local.sqlite
```

正常退出由 AbortSignal 取消请求、结束循环并释放连接。超时/429/5xx 重试受任务预算和分析总调用预算约束。被强制终止的运行和未确认调用标记为中断；旧租约不能提交领域变更。未知用量保留为空，不编造 token 或费用。

`demo:m3` 使用确定性适配器，仅演示本地流转；`m3-live-analysis.mjs` 是用户授权下的真实模型验收脚本，输入仍为合成平台消息，不等于平台采集完成。

## GitHub

只有配置项目 → 私有仓库映射的合格工作条目产生 sync outbox。`worker:m3` 默认不写 GitHub，必须提供 token、仓库、`--project` 和 `--github-write`。repo 的实际 private 状态在发送前核对。

新工单写初版正文和稳定操作标记。后续反馈合并为专用机器人统计评论，之后更新该评论；不会 PATCH Issue 正文、标题或开发者标签。每次显示最多 20 个证据引用，其他原文/引用在本地保留。统计更新默认合并等待 60 秒，持续反馈不无限延后已有等待时间。

创建与评论超时、5xx、进程中断进入 unknown；全状态分页对账后唯一命中才能保存映射与 succeeded，同事务提交。多个命中、缺失权限、分页不完整或长期不可确认会保留 unknown 或转人工。只有明确未受理的失败或确认未生效的自有评论 PATCH 可进入 safe_retry；重试有上限。

GET 状态对账及经 HMAC 验证/去重的 webhook 可以更新本地工作流。Bug closed/completed 映射 Fixed，不映射 Verified；建议 closed 不直接映射 Implemented，而要求复核。回调接收函数已实现，没有部署公网 webhook 服务。

验收的 stdio 桥接使用已连接 GitHub 插件，不保存 OAuth token。其 Issue 全量列举能力不足时不使用 Search 证明“没有创建”；真实未知发送的权威恢复仍需配置 REST provider 或人工复核。

## 尚未覆盖

M2 的官方 QQ Source/Delivery 真实权限、Steam/Discord 采集、Web/报告/QQ 按钮、生产数据保留/删除治理、真实 Embedding 质量和真实语料召回评估仍未验收。没有把本轮小样例当作总体模型准确率或生产发布。
