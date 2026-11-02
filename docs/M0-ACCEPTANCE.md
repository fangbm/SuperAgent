# M0 验收记录

日期：2026-11-02。基线：v0.9；工程版本：0.1.0。

## 交付物

- 可重复构建的 pnpm/TypeScript workspace；依赖使用精确版本和 lockfile。
- `@superagent/contracts`：公共类型、13 份 Schema 和 22 份 fixtures。
- `@superagent/plugin-sdk`：Source/Delivery Host 与插件类型入口，含 P0 opt-in 扩展。
- `@superagent/contract-validation`：构建后可直接加载的 JSON Schema 2020-12 校验器。
- 45 个契约资产的冻结清单，以及架构、API、插件开发说明和 ADR。
- Windows/Linux CI 定义，仅执行构建和测试。

## 本机证据

在 Windows、Node.js 24.4.0、pnpm 11.0.8、Python 3.13.5、uv 0.7.21 下运行 `pnpm check`，退出码为 0：

| 检查 | 结果 |
| --- | --- |
| 包依赖与 private 标记 | 通过 |
| 契约冻结清单，45 文件 | 通过 |
| 三个包的 TypeScript 构建 | 通过 |
| 六组编译期正反例文件 | 通过 |
| Node 运行时与边界测试 | 43 项通过，0 失败 |
| Python/SQLite 参考验证 | 6 套通过 |

Node 测试直接导入构建产物，覆盖全部 fixture 和注册 Schema。另验证 13 种事件的 type/data 配对、格式检查、无类型转换/字段删除、非 JSON 值与循环对象、未知任务类型、固定按钮顺序、报告修订字段、P0 结构限制、投递未知状态，以及错误诊断不回传原文值。

SQLite 回归在内存数据库中运行：原始 ID 唯一性、外部操作竞争领取、多意图证据关联、乐观版本、P0 incident/投递去重、报告成员封存、span 迁移回滚、默认 recursive_triggers=OFF 下的 REPLACE 保护、项目/窗口身份、前序修订封存与历史坏数据迁移回滚。

这些 SQL 验证使用参考 DDL，并没有测试实际 Host 存储实现。路由函数的随包示例不等于运行中的通知策略服务。

## 后续验收边界

- 没有启动采集器、HTTP 服务、Agent Worker、Web 或调度器。
- 没有调用 QQ、Discord、Steam、GitHub 或 LLM API。
- 尚未验证真实消息覆盖率、模型判断质量、吞吐、进程中断恢复、生产数据库升级和真实投递。
- GitHub Actions 文件已配置，尚未远端执行；Linux 结果不作已通过声明。
- 仓库只在本地，未配置远端。所有包为 private，未发布 npm 包或服务。

## M1 入口

下一阶段实现生产迁移执行器、SQLite 连接与仓储、Ingress 原子事务、持久 outbox/jobs、Admission 与 Feedback Buffer。首批验收应覆盖重放 100 次仅一次持久效果、任一事件非法整批回滚、checkpoint 与 outbox 同事务、超时片段重启恢复及 10,000 条事件不触发逐条完整 Agent。
