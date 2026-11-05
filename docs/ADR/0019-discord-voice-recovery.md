# ADR 0019：共享 Gateway 下的临时语音房恢复

2026-11-04。Voice 叠加 Source/Ticket，沿用一个 DiscordPlatform 和既有 Supervisor；独立 voice.ts、配置、命名状态、占用快照、命令和错误诊断。没有录音、语音连接、识别、LLM 或反馈发布代码。Source/SDK/主数据库所有权不变。

## 状态与占用

使用 PR B 的同库命名特性状态，kind=voice，Host 不授予 Ingress 提交函数。room 与入口/房主索引、占用状态、Gateway receipt 同事务提交。Voice State Update 只保存本 guild 的 user/channel ID，GUILD_CREATE 只保留最小占用快照；不保存语音 session/token、音视频标记或整个 Guild 对象。

完整 guild 占用元数据是必要的：响应丢失的房间尚无本地 channelId，若按“已知房间”过滤启动快照，会把实际有人房间误判为空。所有远端动作仍限定配置入口、目标 category 和明确托管的频道；其他占用不形成反馈、不送给模型。

首次启动等待 GUILD_CREATE 完整快照；重启仅在同 session 的持久快照、按序收件箱与 RESUMED 连续性得到确认后恢复占用。READY 新 session、不可用 guild、丢失/失败的占用事件或断线使占用失效；Host 将失败状态持久化，不能通过重启抹去 gap。没有确认就不创建、移动或清理。心跳只延续已确认连接，不凭空建立占用。

## 外部操作与清理

先保存 creating，再创建带稳定名字标记的 type=2 频道。未知结果仅查询精确 guild/category/name/type，查不到不再次 POST。创建后移动成员先保存 moving，结果未知不盲重复移动。其他设置为同一托管频道的目标状态，可通过 GET 核对，再应用幂等 PATCH；不变更 guild role。

只有 owner、在房且现场权限通过的成员可改人数/锁定/解锁/转让；房主离开或失去访问时，从有效占用中选择有权成员。转让与索引变更为原子 CAS，不能覆盖接收者已有的其他房间索引。

清理需要确认的新鲜占用、空房宽限、无待处理事件、匹配托管标记及配置允许。先限制连接并读回权限，再等待安静期限；有人进入即恢复权限并取消清理。删除前持久认领，响应未知只核对是否已消失；仍存在则人工复核，不再 DELETE。成功/已确认删除同时退休 room 和对应索引。Guild Administrator 能绕过频道 overwrite，Discord 没有占用条件 DELETE；有权成员在最终检查与远端操作间进入的竞态不能由本地事务消除，必须保留此限制并做真实权限验收。

## 组合与边界

同一 Bot credential 只允许一个启用的 Discord Platform，静态环境引用重复及启动时实际值重复都拒绝；不通过多个独立插件维护竞争 Gateway。多 Bot 可以使用不同凭据，单 Bot 跨多个独立 guild 实例尚不支持聚合，明确拒绝重复配置。

Source/Ticket/Voice 8 种启停组合分别测试；Voice 明确权限失败不影响 Ticket 归档或公开 Source，反向亦然。每个模块有取消/有限处理预算、正常五秒轮询及故障三十秒冷却；永久配置/授权错误阻塞模块。不添加插件管理器、Agent Runtime、独立数据库或部署入口。
