# 插件开发约定

插件只依赖 `@superagent/plugin-sdk`。Source 实现 `probe/start/sync/stop`；Delivery 实现 `probe/send`。支持 P0 的 Delivery 额外实现 `P0AlertDeliveryPluginV1.sendP0Alert`，不能把普通发送插件自动当成具备 P0 能力。

Source Host 只提供日志、指定密钥、健康、checkpoint 和原子提交，不暴露数据库、Issue 变更或发送权限。Delivery Host 只提供指定密钥与日志。两类实例分别配置和授权，即使共用 QQ 平台也不合并权限。

Source 提交 `NormalizedEventV1`，不构造内部事件 ID；成功回执的 `refs` 包含 Host 分配的 ID，重复事件返回相同映射。平台事件的编辑/删除以新事件表示，不覆盖原始历史。Host 提交成功前不能确认上游或推进分页。

`probe()` 必须检查当前授权账号的真实能力；SDK 方法存在不代表有权限。没有全量采集、历史查询或编辑能力时，报告 `partial/unknown/unavailable` 及原因。平台客户端、重连和取消实现属于后续连接器阶段。

Delivery 只能使用 Host 传入的批准收件人。`accepted` 表示平台受理；`unknown` 表示可能已发送，禁止自行重试。是否能够安全重试由持久外部操作与对账流程判断。M0 只提供类型与格式验证，没有发信实现。

进程内插件的域名白名单是审计声明，不是网络隔离。MVP 只加载经过审核的内置插件，第三方隔离方案另行设计。
