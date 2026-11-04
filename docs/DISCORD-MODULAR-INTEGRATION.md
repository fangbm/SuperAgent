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

## PR B：私人 Ticket

统一配置中的同一 Discord 实例增加 tickets.enabled（默认 false）、allowWrites（默认 false）、独立 projectId、private categoryId 和 staffRoleIds；示例 examples/discord-tickets/superagent.json 全部关闭。关闭公开采集可设 sourceEnabled:false 和 channelIds:[]；Ticket 仍通过同一 Gateway 接收私有消息及交互，不创建自己的 Runtime。Ticket 自己需要 Guild Messages/Message Content Intent。

开启且授权写入后仅注册本应用自己的 `/sa-ticket` 命令，不覆盖其他命令。action 支持 new/view/history/claim/close/reopen/delete；new 还需 kind=bug/suggestion/help、title、body，其他操作传 ticket 编号；view/history 可用 page 查询完整原文和审计。确认前原文与生命周期先可靠归档。用户仅操作自己的工单，claim/delete 需现场核对当前 Staff 身份；Staff 的权限不会由过期 Interaction 内的角色列表授予。回复 ephemeral，禁用所有 allowed_mentions。初始 ACK 使用同一 REST 客户端的优先路径，不排在深历史读取后；token 仅有限期保存在内存。

私人工单在同一 SQLite 的独立 staff-only Project，Host 精确注册，不与公开 Source 混收；M1 只归档，手工重处理、Domain 模型证据与报告生成拒绝该 Project。公开 M3 和其他平台策略不变。启动绑定/隔离原子初始化，模块只持有撤权/CAS 的 namespace port。提交事务包含原文、工单、open-user 索引、receipt 与 inbox 完成；崩溃前未完成收件箱可重放，无需玩家再发 Interaction。生命周期保留短标题和证据引用，未保存 token。私有正文保存在私有归档/收件箱，不能把本机 SQLite 当公开可下载文件。

频道创建先记录 creating，响应丢失按本 guild/category/topic 核对；若查无结果，不再次 POST。权限 overwrite 复核禁止将私人正文发到公开或他人频道。关闭/重开保留原文和审计；删除只对托管且关闭的频道，在分页历史归档及已知 pending 输入处理完成后执行。历史每次最多五页，进度持久化；HTTP/结果未知不会触发第二次不明创建或删除。Bot 需要 View Channel、Read Message History、Manage Channels、Manage Roles 和消息发送能力；不默认申请 Administrator，也不编辑 guild role。频道级权限仍须真实测试服务器验收，服务器所有者/Administrator 天然能绕过 Discord 的频道隐私边界。

Ticket 接口错误保留独立 moduleStatus、错误码及下一次尝试时间，并随 Supervisor 状态输出；Category/权限等明确错误阻塞该业务模块，不终止公开 Source、Core 或其他平台。关闭模块后原私有 Project 隔离记录保留，未完成操作等待明确重新启用；不自动公开或处理旧工单。

迁移采用同库命名特性账本，详见 [ADR 0018](ADR/0018-discord-private-ticket-host.md)。主迁移 001–012 不变，不抢占 #10 的 013；旧 #4 升级库仍明确不支持且拒绝，不提供账本重写。当前没有私有工单进入 M3/GitHub 的授权开关。

PR B 本地验证：完整 pnpm check 的 376 项 Node 与 6 组参考验证通过。新增 14 项回归含真实 SQLite、事务失败、实际子进程 SIGKILL（事务中/提交后）、收件箱无重放恢复、权限、原文分页、历史分页删除、未知外部操作及统一入口真实 M1/M3/M5 配合本机 HTTP 模型替身；不代表真实 Discord/模型验收。后续追加主迁移的兼容测试保留原主 ledger，未改写哈希账本。Source PR #11 Windows/Ubuntu CI 已通过；各分支远端 CI 独立检查。

删除的补充边界：即便 close/delete 连续收到，也先通过 overwrite 阻止请求者继续发送，并在下一次 GET 读回确认后才做最终分页归档与 DELETE。HTTP 成功而权限尚未读回时不会删除。Staff/Administrator 的并发写入仍是远端限制，须按 ADR 0018 验收。

协议核对依据：[官方 Thread API](https://github.com/discord/discord-api-docs/blob/main/developers/resources/channel.mdx)、[Gateway 事件](https://github.com/discord/discord-api-docs/blob/main/developers/events/gateway-events.mdx)、[权限](https://github.com/discord/discord-api-docs/blob/main/developers/topics/permissions.mdx)、[Interaction 响应](https://github.com/discord/discord-api-docs/blob/main/developers/interactions/receiving-and-responding.mdx)。
