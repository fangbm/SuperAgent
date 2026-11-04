# Discord 模块化集成

2026-11-04。三个分模块 Draft PR 从最新 main `d9937a9` 开始，依次为 Source、Ticket、Voice；后续模块可以叠加前一个 PR，但不自动合并或部署。既有 #9/#10 尚未合并，本系列不依赖它们。

## 历史审查与区别

已重新查询 #2/#4/#5/#6/#7/#8：#2/#7/#8 已合并，#4 曾合并后被 #6 回滚，#5 仍 open/unmerged。#4/#5 的 PR 讨论接口未返回评论；其提交说明、审查记录文件与实际代码仍作逐项审查输入。没有整体 cherry-pick。

#4 的公共发现会遍历服务器频道、混合社区功能；本次只保留既有 Gateway/REST 去重与有限补采语义，发现范围限定明确 channelIds 父频道。#5 的工单原子事务思路可用，但其 Core launcher、全局 Source Policy 和旧迁移不移植。只使用当前统一主程序的一套 Runtime/SQLite/Ingress/Queue/Domain/M3/M5/Supervisor。

## PR A：Source 与共享 Transport

- 沿用原连接器心跳、ACK、Resume、识别预算、512 个待提交上限、序列提交和原文去重。REST 抽到独立 transport.ts，支持只读安全重试、有限 429 退避、取消、响应体上限和不明写操作不重发。后续模块共享该实例，不额外建 Gateway。
- `discoverThreads` 默认 false。只在明确配置的 channelIds 下发现活跃公共 Thread 和分页归档 Thread；不调用整服频道发现。private Thread、非本 guild、父频道之外对象不采集。显式频道也必须为公开可读范围，避免把 Bot 高权限误当公开授权。
- 保留每频道 historyPagesPerSync，增加全局 historyRequestBudget（默认 100）、threadPagesPerSync（默认 2）。历史频道轮转，深分页、高水位、已知 Thread、父频道、归档页和 gap 保存到既有 checkpoint；不新增数据库/迁移。
- 新 checkpoint 保存绑定 scope。新增或移除频道保留原历史游标，再次加入从原位置恢复；旧无 scope 的 checkpoint 只有与旧配置签名一致时才安全升级，不猜测旧绑定。权限撤销/删除保留 gap 和原进度，不把失败当空列表。Archive、Checkpoint 仍经冻结 Source Host 原子提交。
- sourceEnabled 默认 true（现有实例仍默认关闭）；显式 false 可让后续 Ticket/Voice 只使用 Transport，不申请公开消息 Intent 或发布公开反馈。可信构造参数可注入持久 dispatch sink、快速 ACK、额外 Intent 和私有频道排除器；JSON 不能注入可执行回调。
- 业务 sink 只持久入箱，不执行远端生命周期；Gateway 序列在 sink 和 Source 归档完成后推进。暂存提交时间使重放稳定；checkpoint 不保存 Interaction token 或私人工单正文。模块失败隔离由后续 Host 收件箱完成。

示例 `examples/discord-source/superagent.json` 全部 disabled，替换实际 guild/channel ID、明确授权后才能开启；唯一正式入口仍为 `pnpm start --config ...`。不会因配置环境变量自动启动。

## 覆盖与待验收

所有 coverage 保持 partial：离线删除、旧编辑、中间版本、无法访问对象和 Discord 归档时间戳分页边界不保证恢复。Gateway/REST 相同完整消息维持一个反馈，实际编辑保留独立版本。单 shard；不声称完整服务器历史或无限吞吐。

本地测试使用实际连接器、真实文件 SQLite、受控 Gateway/REST，不是线上 Bot 验收。真实 Message Content Intent、频道/Thread 权限、限流、长时重连和历史完整性需在获批测试服务器验收。没有真实 Discord 操作、模型调用或部署。

PR A 本地验证：锁文件安装、完整 pnpm check 的 362 项 Node 测试与 6 组参考验证通过，含构建、类型、包边界和 45 个冻结文件；新增 7 项发现/Transport 回归。disabled 示例 check-config 通过。Windows/Linux 远端 CI 随 PR 单独检查。

协议核对依据：[官方 Thread API](https://github.com/discord/discord-api-docs/blob/main/developers/resources/channel.mdx)、[Gateway 事件](https://github.com/discord/discord-api-docs/blob/main/developers/events/gateway-events.mdx)、[权限](https://github.com/discord/discord-api-docs/blob/main/developers/topics/permissions.mdx)、[Interaction 响应](https://github.com/discord/discord-api-docs/blob/main/developers/interactions/receiving-and-responding.mdx)。
