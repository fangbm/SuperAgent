# ADR-0003：M3 有界分析、领域写入与独立 GitHub 同步

日期：2026-11-02。状态：已采用。

保留 M0 冻结的所有类型、SDK、Schema 和默认配置；新增迁移 007 和五个业务包。按照用户要求先做 M3，M2 不被自动视为完成。

模型执行固定的 extract → retrieve → evidence match → domain commit 流程，不执行无限循环或任意工具。分析身份在请求前持久化；每个分析最多 12 次新模型请求、20 个提取项，默认单次超时 30 秒、输入 60,000 字符、输出 4,096 tokens。成功结构化结果缓存按模型/Schema/提示词哈希复用，预算覆盖失败与重试。原文证据、同项目权限和最终租约 token 在提交时再次校验。

检索按项目与 defect/suggestion 隔离，FTS5 使用中英文词组/字串，支持 BM25；可选 Embedding Provider 写入模型版本和文本哈希，通过 reciprocal rank 合并向量排名。没有 Embedding 配置时明确为 lexical 模式，不把字面检索说成语义检索。相似度只检索候选，同一问题必须由证据匹配再校验。

同一原始消息允许多个独立反馈项。重分析保留旧结果并停用旧投影，原始证据不删；引用同一对象的修订不增加独立来源反馈计数。人工重关联/拆分/合并需要授权身份、版本及审计，并记录可重放命令与精确关联覆盖。无法可靠对齐的变化进入人工复核。

GitHub 同步不使用通用任务失败重试替代外部操作协议。持久操作先于网络；创建和评论 POST 的未知结果只对账，不自动重发。分页对账处理所有状态、跳过 PR、要求完整扫描后唯一命中。不存在或不可见不等于未创建。

后续统计放在单条机器人评论，避免覆盖开发者的 Issue 正文。机器人评论被人工修改时暂停自动更新。GitHub 没有在这里被假定提供原子 compare-and-swap；对机器人评论的读-改-写仍存在并发窗口，不宣称能对远端所有同时编辑提供事务隔离。

所有真实写入需显式开启和私有目标验证。桌面 GitHub 插件可通过受控 stdio 桥接完成验收，不提取其 OAuth token。连接器缺少仓库全量 Issue 列举时保持 unknown，不以搜索结果冒充权威对账。

接口依据：[DeepSeek API](https://api-docs.deepseek.com/)、[JSON Output](https://api-docs.deepseek.com/guides/json_mode/)、[SQLite FTS5](https://www.sqlite.org/fts5.html)、[GitHub Issues](https://docs.github.com/en/rest/issues/issues)、[Issue Comments](https://docs.github.com/en/rest/issues/comments)、[Webhook 签名](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)。
