# Discord Source Plugin

Node 24 官方 Gateway/REST 适配器，导出 DiscordConnector、discordConfigSchema 和 normalizeDiscordMessage。实现现有 SourcePluginV1，依赖只有 plugin-sdk。

配置与独立运行命令见 [M4 使用文档](../../../docs/M4-CONNECTORS.md)，配置样例为 examples/config.json。需真实 Bot token、Message Content Intent 和 Guild/Channel/Thread 权限。默认保留 ID 白名单；discovery=public 自动发现公开频道及活动/归档主题串，分页写入 checkpoint。probe 在绑定 Host 前返回 unknown。

可选 onDispatch/onDispatchImmediate、additionalIntents、channelExcluder 与 channelResolver 支持同一 Gateway 下的社区功能及私密工单独立归档。consumeDispatch 为注入式采集入口，不另开连接；动态私密实例须由可信宿主提供解析器。Gateway 提交保存待处理派发的时间，不保存交互令牌，所有路由提交后才推进恢复序号。完整入口与权限/部署说明见 [Discord Bot](../../../docs/DISCORD-BOT.md)。

创建、编辑、删除和批量删除均保留独立历史；checkpoint 保存分页和 Gateway session/sequence。支持心跳、ACK 超时、Resume、不可恢复会话后的有限 REST 补采。始终诚实报告 partial；旧编辑、离线删除、分片协调仍有限制，详见主文档。

验证及未完成权限验收见 [验收记录](../../../docs/M4-ACCEPTANCE.md)。
