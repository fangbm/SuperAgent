# ADR-0001：M0 契约基线与包边界

日期：2026-11-02。状态：已采用。

## 决策

采用 v0.9 设计包作为初始基线，用户明确要求忽略其旧 SHA256SUMS 清单。原包的实际 SHA-256 记录于 `docs/reference/SOURCE.json`；参考文本统一 LF，原旧清单不导入。工作区采用 pnpm 与 TypeScript，先交付可构建、可测试的 contracts/SDK，不创建占位服务。

公共类型和机器 Schema 置于 `contracts`，插件 SDK 仅重导出类型，Ajv 校验放在独立包。这样 contracts 不依赖业务包，Source/Delivery 插件不需导入 Host 或 Agent 内部实现。

使用现有的五份参考迁移运行内存数据库回归，包含封存 REPLACE、修订链、跨项目/窗口身份与坏数据回滚。生产迁移的版本账本、事务封装、运行目录和 SQLite 连接生命周期留到 M1；参考脚本的通过不代表生产存储实现已交付。

M0 补齐回执、投递与任务 Schema，以及对应 fixtures；只补全 v0.9 已存在的接口边界。报告 `reportRevision` 与 presentation 的关联仍由 Host 校验，`unknown` 不隐式转换为可重试状态。

仓库仅本地初始化，所有包为 private。任何以后托管使用私有仓库。CI 只验证，没有发布或部署动作。

## 验收

`pnpm check` 是单一入口。验收包含真实构建产物的运行时校验、编译期正反例、依赖边界正反例和参考 SQL 回归。平台联调、模型质量、1 万消息吞吐和进程恢复在对应后续阶段验收。
