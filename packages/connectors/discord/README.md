# Discord Source Plugin

Node 24 官方 Gateway/REST 适配器，导出 DiscordConnector、discordConfigSchema 和 normalizeDiscordMessage。实现现有 SourcePluginV1，依赖只有 plugin-sdk。

配置与独立运行命令见 [M4 使用文档](../../../docs/M4-CONNECTORS.md)，配置样例为 examples/config.json。需真实 Bot token、Message Content Intent 和指定 Guild/Channel/Thread 权限；默认只读取 ID 白名单，可显式开启限定父频道的公共 Thread 发现。probe 在绑定 Host 前返回 unknown。

创建、编辑、删除和批量删除均保留独立历史；checkpoint 保存分页和 Gateway session/sequence。支持心跳、ACK 超时、Resume、不可恢复会话后的有限 REST 补采。始终诚实报告 partial；旧编辑、离线删除、分片协调仍有限制，详见主文档。

验证及未完成权限验收见 [验收记录](../../../docs/M4-ACCEPTANCE.md)。
## 模块化扩展

当前统一入口可选 `discoverThreads:true`，仅发现 channelIds 下的公共活跃/归档 Thread；默认关闭，不遍历整服频道。配置示例和 checkpoint/权限/历史兼容说明见 [模块化集成](../../../docs/DISCORD-MODULAR-INTEGRATION.md)。后续 Ticket、Voice 复用同一 Transport，不另开核心运行时。
