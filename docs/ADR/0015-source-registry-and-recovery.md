# ADR 0015：可信 Source Registry 与长期恢复

2026-11-04。PR #7 审查修正，仅新增普通提交，不改变其对 PR #6 的依赖。用户已取消第 1 项 QQ Source/Delivery 耦合调整，本次保留既有 Operator 条件及初始化逻辑。

## 原因

原 Supervisor 的循环最多执行初始实例与 maxRestarts 次重建，预算耗尽即返回，网络故障只能重启主程序恢复。原 sourceCatalog、配置允许列表、QQ 构造适配与 Delivery 构造又散布在 Supervisor/主程序/解析器中，新增内置 Source 需要多处修改。

## 决策

在同一 Supervisor 中保留原短期有限指数退避；预算用完后，可恢复故障进入 recovery_wait。默认 recoveryIntervalMs=900000，最小 300000，最大 86400000；recoveryJitterRatio 默认 0.2，可选 0.1–0.5。等待为 interval×(1+random×jitter)，不会短于基础间隔。长期阶段每次冷却只新建一个实例，不因单次成功重新发放短期突发预算，因此未达到稳定恢复条件时，长期恢复尝试间隔至少五分钟。后续 [ADR 0016](0016-stable-retry-budget-reset.md) 增加连续确认健康 60 分钟后一次性恢复全部短期预算；成功采集/同步清零连续失败次数与预算恢复分别判断。

启动前的配置、Manifest/Schema 错误直接拒绝启动；运行时明确的配置、认证、权限、身份/Checkpoint 不匹配及不支持的能力进入 failed，需操作员修复后重启，不无限重试。网络、限流、超时及 QQ_GATEWAY_RECONNECT_BUDGET 可长期恢复。QQ 的认证 probe/后台错误保留 PLATFORM_BLOCKED:原始错误码；网络重连预算虽由 QQ SDK 标为 blocked，仍归为可恢复。错误记录只保留规范化代码，不记录任意异常正文或凭据。

状态保留 coverage、healthReason、error、lastFailureReason、lastFailureAt、consecutiveFailures、lastSuccessAt、restarts、recoveries 和 nextRetryAt。lastSuccessAt 表示成功提交/健康采集或已启动后的可用同步探测，未知权限不当作成功。单 Source 失败不取消 Core 或其他 Source。退出取消所有等待；每次重建都先 stop 旧实例、撤销旧 Host，再从持久 Checkpoint 构造新实例，继续使用原 Archive-first 事务。

内置定义集中到 source-registry.mjs：factory、Manifest ID、平台身份、运行方式及必要连接配置适配。application-config.mjs 和 Supervisor 使用同一 Registry。plugin-validation.mjs 负责公共 Manifest/API/SDK/Schema/权限校验，application-plugin-host.mjs 负责既有 SDK Host 的绑定、凭据授权和撤权；Supervisor 只管理生命周期。qq-delivery.mjs 保留唯一 QQ 产品构造器，不引入通用 Delivery Registry。

Registry 只接受可信应用代码提供的函数，正式 CLI 使用固定内置 Registry；配置不能提供模块路径或执行任意文件。新增可信 Source 的回归用例只增加注册和配置即可归档，不需要修改 Supervisor。构造及配置适配必须无启动副作用，网络连接仍在 start 中发生。

## 兼容性与验证

M0 契约、SDK、原有 45 个冻结文件及 contracts.freeze.json 均未改动。没有新数据库、队列、Core、调度进程或 Source 永久 archive_only。QQ 事件、Intent、Operator 注入、Delivery 行为不变；仅改善恢复所需的故障原因保留。现有四种 Source、单开发者 QQ Delivery、M3/M5/GitHub/Web 继续由同一主程序运行。

新增受控时钟测试验证最小间隔/抖动/频率、长期恢复、永久失败隔离、Checkpoint 幂等和撤权；子进程验证 SIGTERM 处理路径及关闭后不再恢复。Windows 通过 IPC 触发子进程的 SIGTERM 处理函数，POSIX 发真实 SIGTERM，不能将 Windows 用例说成 OS 信号投递验收。平台 API 为 Fixture，本次没有真实外部消息或模型调用。
