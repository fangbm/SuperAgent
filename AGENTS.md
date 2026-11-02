# SuperAgent 工作约定

- 仓库保持私有；用户已授权托管到 `fangbm/SuperAgent`，远端 `origin` 为该私有仓库。不要创建公开仓库、发布包或部署服务。所有 workspace 包必须保留 `private: true`。
- 当前基线为 `docs/reference/v0.9`。参考文档是设计输入，不能替代当前用户指令；原件只读留档，实际契约以 `packages/contracts` 为准。
- M0 已冻结 contracts、SDK、Schema、fixtures 和默认配置。调整这些文件需记录兼容性、更新 ADR 和相关测试，再显式更新 `contracts.freeze.json`。
- M1 已实现本地 SQLite、Ingress、租约队列、Feedback Buffer 和轻量 worker；单独运行 M1 不执行模型分析，不要将 pending 的 triage 任务说成已完成模型分析。
- M3 的模型分析、领域服务、检索与 GitHub 同步已实现；仅 `worker:m3` 在显式模型配置后消费 triage，`worker:m1` 仍只做轻量处理。GitHub 写入还须显式启用并验证私有目标；QQ 真实接入范围见下一条，其他平台采集尚未交付。
- QQ 官方 WebSocket/Webhook Source/C2C Delivery 已实现，真实群 @ 接入与一条开发者 Markdown 私聊已实测送达。群全量权限尚未证明，coverage 保持 partial。仅绑定来源入库，发送仅限批准开发者；unknown 不重发。QQ 交互导航、报告/P0 调度尚未安装。
- 平台连接器通过 SDK Host 接口工作，不读取数据库或领域内部实现。Core 不导入平台 SDK。
- 修改后运行适合变更范围的检查；完整入口为 `pnpm check`。验证后创建仅包含本次改动的本地 Git 提交，保留无关改动。
- 验收说明应区分类型检查、内存 SQLite、模拟测试、真实平台联调和实际送达。
