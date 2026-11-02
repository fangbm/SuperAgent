# M3 验收记录

日期：2026-11-02。范围：按用户要求从 M1 继续 M3，M2 尚未验收。代码只保留本地 Git，无远端配置，无发布或服务部署。

## 交付与本地检查

新增五个私有包：`llm`、`memory`、`domain`、`agent-workers`、`issue-tracker`，以及 SQLite 迁移 007。提供生产配置的 `worker:m3`、确定性 `demo:m3` 和独立的真实联调脚本。M0 的 45 个冻结文件未修改，原六份迁移保持一致。

在 Windows、Node 24.4.0、pnpm 11.0.8 下：

- `pnpm install --frozen-lockfile` 成功。
- `pnpm check` 通过依赖/私有包边界、45 文件冻结校验、十三个包构建、类型正反例、109 个 Node 测试、6 个 Python/SQLite 参考验证套件。
- Node 测试覆盖实际文件 SQLite、进程强制终止与恢复、租约过期 fencing、模型超时/429/无效结构、最终事务回滚与成功响应缓存、重分析/人工覆盖、证据伪造拒绝和检索项目隔离。原 M1 的 10,000 条合成消息测试仍通过。
- 本地 HTTP 测试验证模型与 GitHub REST 协议及生产 CLI；它们使用模拟服务，不能代替真实平台验收。缺失/非法 token 用量记录为 null，不伪造为零。
- 外部操作模拟覆盖写前持久化、成功后本地提交失败、unknown 对账、多页/PR/重复标记、人工修改评论、私有仓库限制和 webhook HMAC/重放验证。

## 真实模型

用户提供并授权的接口：`https://api.deepseek.com`，模型 `deepseek-flash`，JSON object 模式，thinking disabled。密钥只用于临时进程输入，没有写入源文件、示例配置或验收记录；仓库文件扫描未命中该密钥。

输入是**合成 QQ/Discord 消息**，通过已有 Source Host 入库，并在验收脚本中手动关闭样例批次。没有登录、采集或发送真实 QQ/Discord 消息。

成功路径：两个批次、两次提取和一次 Bug 匹配，共三次真实模型调用。混合消息拆出一个 Bug 和一个建议；后续另一来源的崩溃反馈检索并关联同一个 Bug。Bug 独立来源对象计数 2，建议计数 1，均保留精确原文证据。实际检索为 FTS5/BM25 lexical 模式，没有配置真实 Embedding。

这三次成功调用的服务端用量合计 input 3,384 / output 927 tokens。该数字仅涵盖成功路径；先前被拒绝的试验不计入此数，未知用量不推算费用。早期模型试验曾返回错误 span，系统拒绝写入领域数据；随后修改提示词要求逐字引文且不估算偏移，没有放宽证据校验。

## 真实 GitHub 写入与读回

发送前通过已连接 GitHub 插件确认 `fangbm/sa-test` 为私有仓库。用户明确批准创建以下两条测试 Issue，并验证 Bug 的一条统计评论：

| 对象 | 真实结果 |
| --- | --- |
| 建议 | [#1 [M3 验收] Automatic reconnect after disconnection](https://github.com/fangbm/sa-test/issues/1) |
| Bug | [#2 [M3 验收] Multiplayer loading crashes at 90%](https://github.com/fangbm/sa-test/issues/2) |
| Bug 统计评论 | [comment 6577591919](https://github.com/fangbm/sa-test/issues/2#issuecomment-6577591919) |

两条 Issue 和一条评论均已通过插件读回，Bug 评论包含独立来源反馈数 2。三条持久外部操作均为 `succeeded`，关联对象分别为 Issue 1、Issue 2、Comment 6577591919；桥接进程正常退出 0。统计评论由手动统计刷新触发，没有再制造第三条原始反馈。

实际请求经 `GitHubSyncManager` 与受控 stdio 插件桥发送，没有提取 OAuth token。默认 REST provider 在本地 HTTP 模拟中验证；未知发送的真实恢复、多页对账、后续评论 PATCH、远端人工编辑冲突和 webhook 均没有在真实仓库故障注入。本轮不额外编辑或关闭已创建的测试对象。

## 证据和剩余边界

可提交的脱敏摘要：[m3-live-2026-11-02.json](evidence/m3-live-2026-11-02.json)。完整运行轨迹和数据库保留在 Git 忽略目录：

- `.artifacts/m3-live-ZlSyv7/state.sqlite` 与 `result.json`：真实模型成功路径；其中 `remoteWritesPerformed: false` 是模型阶段快照，不能代表后续 GitHub 阶段。
- `.artifacts/m3-live-github-result.json`：后续三次真实写入、映射、读回及最终操作状态。
- `.artifacts/m3-github-drafts.json`：用户批准前准备的两份草稿。

没有验收 M2 的真实平台采集、QQ 官方权限和对外投递，也没有交付 Web、报告生成、QQ 动作按钮或公网 webhook 服务。向量检索只做了可控测试，没有真实 Embedding/大语料质量评估。本轮小样本只能证明指定链路运行成功，不能代表总体准确率、生产吞吐、Linux CI 或完整发布验收。

后续统计不覆盖 Issue 正文；机器人评论的读后 PATCH 存在 GitHub 端同时编辑窗口，当前未假设远端提供原子条件更新。插件没有权威全量 Issue 列举能力时，unknown 不自动重发，需 REST 对账或人工复核。
