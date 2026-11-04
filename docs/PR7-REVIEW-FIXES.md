# PR #7 审查修正记录

日期：2026-11-04。起点 `76cee0c860692883aaa6ac398529c0b6fbeb456d`，原分支 `codex/unified-application`，PR base 保持 `codex/revert-pr4`（#6），没有创建新 PR 或重写历史。

## 范围

用户随后明确取消第 1 条，因此不修改 QQ Source/Delivery 独立启停、Operator 注入或初始化时机。初次核对也发现原代码已有 delivery 条件，并非无条件注入。application.mjs 本轮只调整 Registry/校验/Host/Delivery 模块引用及可信测试依赖传递，原 Operator 条件和闭包保留。

## 插件永久离线

原因：旧循环在 maxRestarts 用完后退出，所有错误最终都只能等待整个应用重启，且通用 PLUGIN_CAPABILITY_UNAVAILABLE 容易丢失明确认证失败的原因。

修复位于 scripts/application-plugins.mjs、scripts/application-config.mjs 与 QQ Source 的故障原因上报：

- 原短期退避保留；耗尽后 recovery_wait 每次冷却重建一个实例，默认 15–18 分钟。配置最低基础间隔 5 分钟、抖动至少 10%，不重新发放短期突发重试额度。
- 规范化错误分类；明确配置、认证、权限、身份/Checkpoint 和能力错误停止重试。QQ 的永久平台拒绝和短暂认证网络不可用区分，重连预算耗尽仍可恢复。
- 状态包含连续失败数、最近成功/失败时间、错误码与原因、重建数和下一次恢复时间；失败不会将其他 Source 或 M1/M3/M5 关闭。
- stop 后撤销旧 Host，重建使用新实例及已提交 Checkpoint。关闭取消全部短期/长期等待。

## Registry 扩展性

原因：四个平台允许列表、构造器、运行方式和 Manifest ID 在多个模块重复，QQ Delivery 也混在 Source Supervisor 中。

修复位置：

| 模块 | 职责 |
| --- | --- |
| scripts/source-registry.mjs | 可信内置注册与构造元数据、连接参数规范化 |
| scripts/plugin-validation.mjs | Manifest ID、API/SDK、配置 Schema 和权限校验 |
| scripts/application-plugin-host.mjs | 绑定来源、凭据白名单、Host 撤权 |
| scripts/application-plugins.mjs | 平台无关 Supervisor、健康和恢复 |
| scripts/qq-delivery.mjs | 既有 QQ Delivery 构造/校验，未扩展产品范围 |

配置解析与 Supervisor 使用同一 Registry。JSON 无法指定可执行模块；新增可信 Source 的测试仅增加注册与配置，直接通过原 Supervisor 和 Host 归档。

## 实际验证

执行 `pnpm install --frozen-lockfile`、完整 `pnpm check`：**276 项 Node 测试、6 组 Python 参考验证全部通过**，build/typecheck、包边界和 45 个冻结文件检查通过。新增 15 个计数测试（包括永久错误的 3 个子测试），不是新增真实平台联调。

重新运行 application-*.test.mjs：**29 项通过**，包含原统一入口 E2E、生命周期与实际 SIGKILL 恢复，另新增 Registry 和长期恢复用例。QQ Source 新增真实插件类的受控 HTTP 401/503 区分测试。

新增覆盖：短期恢复；短期预算后长期成功；持久故障的最小间隔和抖动；配置/认证/权限永久错误不重试；其他 Source 和 Core 继续运行；旧 Host 拒绝提交；Checkpoint 恢复不跳过/重复归档；正常关闭取消所有等待；子进程 SIGTERM 处理后无后续尝试；注册解析、未知模块拒绝、Manifest ID 和权限/Schema 检查；无需修改 Supervisor 的可信新 Source。

长期时间推进为隔离的测试时钟，不能绕过正式配置的五分钟下限。Windows SIGTERM 用例通过子进程 IPC 触发已注册处理函数，POSIX 使用 OS 信号；这证明关闭链路，不证明 Windows OS 支持 POSIX 信号。外部接口均为 Fixture，没有付费模型、真实 QQ/Discord 消息、GitHub Issue 或服务器资源操作。

M0 冻结目录、三份默认策略、contracts.freeze.json 均与本轮起点一致；PR #6 分支仍为 00b8c87。完整机器摘要见 [PR7 修正证据](evidence/pr7-review-fixes-2026-11-04.json)。
