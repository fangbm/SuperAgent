# 插件开发约定

插件只依赖 `@superagent/plugin-sdk`。Source 实现 `probe/start/sync/stop`；Delivery 实现 `probe/send`。支持 P0 的 Delivery 额外实现 `P0AlertDeliveryPluginV1.sendP0Alert`，不能把普通发送插件自动当成具备 P0 能力。

Source Host 只提供日志、指定密钥、健康、checkpoint 和原子提交，不暴露数据库、Issue 变更或发送权限。Delivery Host 只提供指定密钥与日志。两类实例分别配置和授权，即使共用 QQ 平台也不合并权限。

Source 提交 `NormalizedEventV1`，不构造内部事件 ID；成功回执的 `refs` 包含 Host 分配的 ID，重复事件返回相同映射。平台事件的编辑/删除以新事件表示，不覆盖原始历史。Host 提交成功前不能确认上游或推进分页。

`probe()` 必须如实报告已有能力证据，SDK 方法存在不代表有权限；允许未验证时返回 unknown，不能伪造网络检查成功。QQ、Discord 和官方 Steam Reviews 的探测方式各不相同；统一应用中的评价评论与 public Discussions 使用被动 probe，返回未知或已有健康状态，真正联网验证发生在绑定 Source Host 后的 sync 中，以便首次 429 也能持久保存冷却期限。独立诊断模式的主动 probe 与 sync 串行；评论诊断会在发现候选后实际读取评论端点，没有可验证评论时保持 unknown。没有全量采集、历史查询或编辑能力时，报告 `partial/unknown/unavailable` 及原因。QQ 认证与已观察事件分开记录；不支持历史补拉/编辑对账，也不声称认证成功意味着主动发信可用。

内置 Source 的构造、平台身份、配置规范化、可选初始化和稳定健康判据集中在可信 `scripts/source-registry.mjs`。Manifest/API/SDK/Schema 校验、Host 授权/撤权及 Supervisor 生命周期分别管理；JSON 不能指定任意模块路径。初始化器属于可信应用代码，可准备持久 checkpoint 或返回冷却期限；平台插件仍只经冻结 Host 提交数据。可恢复故障由同一 Supervisor 执行有限短期退避与长期冷却，新实例从已提交 checkpoint 恢复；关闭取消待恢复任务。详见 [统一主程序](UNIFIED-APPLICATION.md)。

Delivery 只能使用 Host 传入的批准收件人。`accepted` 表示平台受理；`unknown` 表示可能已发送，禁止自行重试。是否能够安全重试由持久外部操作与对账流程判断。当前 `plugin-host` 已提供 QQ 私聊持久发送记录；实际权限、受理和客户端送达按 [QQ 验收](QQ-ACCEPTANCE.md) 区分。

进程内插件的域名白名单是审计声明，不是网络隔离。MVP 只加载经过审核的内置插件，第三方隔离方案另行设计。
