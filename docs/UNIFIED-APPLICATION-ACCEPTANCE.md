# 统一入口验收

日期：2026-11-04。范围为本地集成与故障测试，不是新一轮真实平台权限、实际送达或长期部署验收。

## 基线与 PR

- 远端 main：66eecc53559ff48f5fcb7f158b7cf154dc3f6f28；原工作区 main：04392e6，无未提交改动。原工作区未切换分支或修改文件。
- PR #1/#2/#3 已合并，分别保留 Steam Reviews、Discord、Steam Discussions 快照基础适配器。
- #4 合并提交通过 00b8c87793527c67ea6451d03f7ac1e4ff8286d3 新 Revert Commit 撤销，完整反向树与第一父提交 448c2cc 一致，仅另加回滚说明。[PR A #6](https://github.com/fangbm/SuperAgent/pull/6) 为 Draft，base main。
- #5 仍开放，非 Draft、未合并；分支 fix/core-owned-plugin-ingestion，核对 head 8f29b2949f089d012f42a8cb7689a3d8865eb304。仅参考其思路，不引入 Source 永久禁分析策略或社区功能。
- PR B 分支 codex/unified-application，base codex/revert-pr4，依赖 #6，保持 Draft。SHA 与链接以最终提交/PR 为准。

## 实际执行

PR A：pnpm install --frozen-lockfile 与 pnpm check 通过：244 项 Node 测试、6 组 Python 参考验证、build/typecheck、边界和 45 个冻结文件。

PR B：`pnpm install --frozen-lockfile` 与完整 `pnpm check` 通过：**261 项 Node 测试、6 组 Python 参考验证**，build/typecheck、依赖边界与原有 45 个冻结文件校验通过。相对回滚基线增加 15 项应用集成/生命周期/恢复测试、1 项平台无关包边界测试及 1 项冻结保护测试。脱敏摘要见 [机器记录](evidence/unified-application-2026-11-04.json)。

另执行 `pnpm start --config config/superagent.json --check-config` 与有界 `pnpm start --config config/superagent.json --run-for-ms 300`，验证正式命令解析、单进程启动/退出和默认外部操作关闭。默认零启用平台的 smoke 不作为平台已启动证据；四平台启动由下面实际适配器集成测试证明。

## 贯穿组件的测试

`application-e2e.test.mjs` 使用一个真实文件 SQLite 和正式 createApplication/run 管理循环：

- Discord 的真实 Source 类通过可控 REST/Gateway Fixture 启动，Steam Reviews 的真实类通过受控官方形状响应启动；QQ 真实 Source 类由主程序启动 webhook，通过本机 HTTP 收到签名普通群消息，同一事件重复提交不增加记录；Discussions 的真实类读取合法本地快照。
- 四个实例均由配置自动加载、probe/start/stop，QQ/Discord/Steam 的三条相同 Bug 先 Archive，经原有 Buffer 与真实 AnalysisWorker，使用本机 HTTP 模型 Fixture 提取/匹配，归并为一个 Bug、三个独立反馈。两个跨平台匹配调用有原文证据。
- 原有 GitHubSyncManager 写入可控私有仓库 Port Fixture，仅创建一个 Issue；三来源统计评论汇总正确。原有 ReportService 由主程序调度生成北京时间 00:00–18:00 窗口报告，单一 Bug、3 来源事件、1 Steam 差评成员。既有 QQ Delivery 类调用受控发送接口，Web 实际 HTTP 登录并返回渲染 HTML。
- 正常重启复用 checkpoint、事件与封存报告，没有额外模型分析、Issue 或报告投递；QQ unknown 保留不重发，GitHub unknown 通过权威 Fixture 对账而不重复创建。
- 阻塞模型 Fixture 时，M1/M5 独立循环仍能合批、按固定窗口生成带 pendingAnalysis 的报告，不必等模型返回或另开 Worker。

上述外部接口均为 Fixture：没有新增付费模型调用、真实 GitHub Issue、QQ 消息、Discord 消息或服务器资源操作。Discussions 快照是明确降级模式，不证明远端采集。

## 生命周期和故障

`application-lifecycle.test.mjs`、`application-recovery.test.mjs` 和 tooling 测试覆盖：

- Manifest/API/SDK/Schema/权限拒绝，未批准的模型调用与 Source 业务策略拒绝。
- 四来源 Host 身份、secret 和 checkpoint 隔离，伪造事件/跨来源 checkpoint 拒绝；Host 不暴露数据库/领域/策略管理。
- 阻塞 start 不重复 sync；QQ 后台健康失败有界恢复且不被 sync 擦除；Source 不可用如实报告，其他 Source 已提交数据保留。
- 实际子进程 SIGKILL：归档与 checkpoint 已提交、尚未消费的 outbox 保留；同机 owner 恢复后只推进一次，模型关闭的 triage 仍 pending。
- 201 条来源事件双份重放只归档 201 条，200 条反馈持续等待分析，1 条普通问候仍走原有逐消息 archive_only；重启不丢数据或重复任务。
- 真实 Steam Reviews 类处理 Fixture HTTP 429 和退避，保留原子 checkpoint。
- 同库第二个主程序拒绝，正常关闭后可重新打开；不合作插件的 Host 在有界停止后失效。
- 原有 45 个冻结文件及哈希仍被检查，连接配置可编辑不使三份默认策略失去保护；Ingress 等平台无关包禁止导入具体平台实现。

## 限制

未新增真实平台联调、远端 Discussions、P0 调度、私有工单 ACL、长期压力测试或生产部署。默认配置仍须操作员填入实际平台 ID、凭据并显式授权模型/外部写入。#4 的 Discord 社区和 Steam 扩展未恢复。一个应用配置管理一个项目与一个现有开发者 Delivery 绑定；插件是受信任进程内代码，不是任意恶意代码沙箱。
