# SuperAgent 工作约定

- 仓库保持私有；用户已授权托管到 `fangbm/SuperAgent`，远端 `origin` 为该私有仓库。不要创建公开仓库、发布包或部署服务。所有 workspace 包必须保留 `private: true`。
- 当前基线为 `docs/reference/v0.9`。参考文档是设计输入，不能替代当前用户指令；原件只读留档，实际契约以 `packages/contracts` 为准。
- M0 已冻结 contracts、SDK、Schema、fixtures 和默认配置。调整这些文件需记录兼容性、更新 ADR 和相关测试，再显式更新 `contracts.freeze.json`。
- M1 已实现本地 SQLite、Ingress、租约队列、Feedback Buffer 和轻量 worker；单独运行 M1 不执行模型分析，不要将 pending 的 triage 任务说成已完成模型分析。
- M3 的模型分析、领域服务、检索与 GitHub 同步已实现；正式统一入口在显式模型配置后消费 triage，不需另开 worker。独立 `worker:m3` 仅供调试，`worker:m1` 仍只做轻量处理，不能与正式入口并发操作同库。GitHub 写入还须显式启用并验证私有目标；QQ/Steam 的真实验证与 Discord 的受控接口测试分别记录，不将连接器实现等同于部署权限验收。
- QQ 官方 WebSocket/Webhook Source/C2C Delivery 已实现。指定真实用户群与验收群的不 @普通消息、默认自动批处理和真实模型调用已实测；coverage 仍因无历史/编辑对账保持 partial，不能推断其他群权限。主链路证据见 docs/QQ-MAINFLOW-ACCEPTANCE.md；triage-v2.2 已用保存的真实 QQ 样例和真实模型验证 Bug 独立反馈数 2、建议有效反馈数 1，匹配字段说明修订后可关联原建议，无重复或误触发复核。真实区别仍阻止自动关联，旧待复核副本不自动修改，空历史工作项不得当作有效反馈。真实用户群与验收群 DPAPI 配置分别保留，禁止静默混用。仅绑定来源入库，发送仅限批准开发者；unknown 不重发。M5 导航与原文查询已实现，真实按钮验收以 docs/M5-ACCEPTANCE.md 为准。
- M5 已实现固定窗口封存报告、补报、QQ/Web 共用状态动作、本机 Web 关联纠错和控制台；QQ 没有移动/拆分/合并纠错入口。独立 start:m5 不运行模型分析，正式统一入口可同时运行 M3；默认禁止 QQ/GitHub 外部写入。新修订不自动额外发送，旧修订与原文锚点不可改写。本分支补齐默认关闭的 P0 证据确认/独立告警与统一入口 Embedding，见 docs/P0-AND-EMBEDDING.md；只有本地受控接口验证，没有真实 P0 送达或向量质量验收。
- M6 本地故障与安全审查已交付，专项入口 `pnpm test:m6`，证据见 `docs/M6-ACCEPTANCE.md`。网关待提交队列有界，投递前复核绑定，GitHub 恢复只处理自己的仓库，Web 密钥轮换撤销旧会话；真实平台故障注入和长期压力测试尚未进行。
- QQ ACK 使用互动体 `d.id`，被动回复使用外层 `payload.id`，禁止混用或缺失时自动改主动发送。当前文档核对见 `docs/QQ-PROTOCOL-AUDIT-2026-11-03.md`；首轮四条额度已用完，后续独立复测已确认被动原文分页正常。各轮预算分别记录，旧待处理点击不得自动补发。
- 平台连接器通过 SDK Host 接口工作，不读取数据库或领域内部实现。Core 不导入平台 SDK。
- 统一正式入口为 `pnpm start --config config/superagent.json`，已随 PR #7 合入 main；回滚 #6 与 Steam 后续 #8 也已合并。应用复用一个 M1Runtime 与既有 M3/M5；配置启用的插件由主程序监督生命周期。默认根配置关闭模型、平台实例和外部写入，Steam 专用示例显式启用采集与 M3。当前功能/验收边界见 docs/PROJECT-STATUS.md，历史验收记录保留当时状态。PR #5 保留参考；后续 PR 默认 Draft，除非用户明确授权，不自动合并或部署。
- Steam 后续采集通过 `examples/steam-public/superagent.json` 接入同一主程序：官方评价可选 all、评价评论为独立 Source、Discussions 可选 public（默认仍 unavailable，snapshot 保留）。站点原生接口只报告 partial；真实有界读取、合成回归和旧19条评论回放分别记录在 docs/STEAM-PUBLIC-FEEDBACK.md。原始库不得因测试改写，不恢复 #6 已回滚的社区/工单/语音/部署实现。
- 默认 auditSampleRate=0.02；少量普通消息会成为 audit_sample，在启用 M3 后仍可能调用模型。不能承诺所有无关消息零模型调用。统一正式入口目前使用 FTS5/BM25；SA_EMBED_* 的自动装配仅在调试 worker:m3 中实现。
- 修改后运行适合变更范围的检查；完整入口为 `pnpm check`。验证后创建仅包含本次改动的本地 Git 提交，保留无关改动。
- 验收说明应区分类型检查、内存 SQLite、模拟测试、真实平台联调和实际送达。
