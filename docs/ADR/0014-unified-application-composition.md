# ADR 0014：统一应用组装与受监督插件

2026-11-04。状态：本地实现，待两个 Draft PR 审查；不自动合并或部署。

## 决策

正式入口为 `pnpm start --config config/superagent.json`。`scripts/application.mjs` 只组装一个既有 M1Runtime，向既有 M3 Worker、HybridMemory、DomainService、M5 和 Host 注入相同 runtime/store/queue。M5 增加可选依赖注入参数；旧签名和调试命令默认行为兼容。没有第二套队列、Agent 或领域处理流程。

Source 只接收冻结 `SourcePluginHostV1`。应用检查 Manifest、API/SDK 版本、配置 Schema、权限授权和来源身份；既有平台类通过应用层 registry 构造。长期 start 任务由 supervisor 持有，不能丢弃 Promise。Discord/Steam 的 start 已自行 sync，监督器不额外并发 sync；QQ start 返回后才可周期 sync。探测失败或 Host 健康不可用超出宽限期时停止旧实例，以有限指数退避创建新实例，从已提交 checkpoint 恢复。旧 Host 在重启/停止后失效。单插件失败不停止其他插件或删除数据。

新增运行时迁移 `012_application_owner.sql` 仅管理应用所有权。SQLite 事务互斥取得 token，并拒绝存活进程或其他主机所有者；同机崩溃的已消失 PID 可恢复。Host 写入检查 token。停止时先关闭回调入口、取消新采集，等待 stop 和已持有任务，再释放 owner、关闭数据库。调试入口不是正式运行的依赖，不能与正式入口并发操作同库；此 owner 机制不是给任意手工 SQL 提供安全沙箱。

## M0 兼容性及冻结清单

全部冻结 TypeScript、SDK、Schema、fixture、参考迁移和三份 `*.default.json` 字节不变，仍为原有 45 文件。新 `config/superagent.json` 与 `config/plugins/` 是可编辑的运行配置，不是新的 M0 默认业务策略。原冻结脚本递归收集所有 config 文件，会把连接配置错误视为契约库存变更，因此显式在 `contracts.freeze.json.applicationConfigPaths` 记录这两个路径，并在脚本中校验精确排除项；原 files 字典、baseline 和全部 45 个哈希不变。其他 config 新文件仍触发库存检查失败，冻结文件变更仍失败。相应 tooling 测试验证这一区分。

模型、GitHub 和 Delivery 写权限由主配置分别显式授权，环境变量本身不能打开服务。Source 配置不包含业务分析开关，M1 原有逐消息 archive_only Admission 保留。已有公开来源使用同一 Archive-first 流程。私有工单和披露 ACL 属于后续移植，不自动接入本入口。

## 边界

本轮只恢复 PR #1–#3 的连接器；PR #4 社区功能、Steam 扩展及 PR #5 不合入。Steam Discussions 仅支持本地快照，远端模式明确 unavailable。P0 即时调度尚未交付，启用请求明确报错。本应用当前管理一个 projectId 与一个既有批准开发者 C2C Delivery 绑定；重复 Delivery 绑定拒绝启动，避免重复发送。插件是受信任的进程内实现，声明权限与依赖边界不等同于 JavaScript/网络沙箱。
