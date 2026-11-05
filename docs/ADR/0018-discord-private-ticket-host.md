# ADR 0018：共享 Discord Gateway 与私人工单 Host

2026-11-04。Ticket 叠加 Source PR A；不依赖尚未合并的 #5 或 P0/Embedding #10，不恢复旧 Bot Core。

统一应用使用原 Supervisor 管理一个 DiscordPlatform SourcePlugin。source.ts 继续负责原 Gateway 和公开采集，tickets.ts 为独立业务模块，Transport 为同一个 REST/Gateway。源关闭而 Ticket 开启时仅保留所需 Transport/私信道消息 Intent；没有第二个 Runtime 或数据库。模块有自己的诊断状态、取消与低频恢复，不能以模块错误覆盖 Source 健康。持久收件箱是平台交互的归档回执/重放日志，非另一套 Agent Job Queue。

Core 初始化时原子注册精确私有绑定及 staff-only Project 隔离记录。模块获得 namespace-scoped port，不得到 SQLite/Ingress；Host 对原始事件、pending 工单、open-user 索引、Interaction receipt 和 inbox 完成执行同一同步事务。失败全部回滚，未处理的收件箱在启动后恢复，不依赖 Discord 重放。状态 CAS 与 Host 撤权阻止旧实例写入。

M1 将该私有 Project 归档为 archive_only，强制重处理、Domain 模型证据和报告生成拒绝进入。没有更改任何 Source 的永久处理策略，不扫描/覆盖 QQ 或 Steam。后续私有分析授权没有实现；不能靠设置环境变量或公开 M3 开关绕过隔离。

Discord 状态采用 plugin-host/migrations/discord-state-v1.sql 的命名特性迁移和独立哈希账本，在同一主 SQLite 执行。全局 001–012 与冻结文件不改；不占用并行 #10 的 013，亦不恢复 #4 被回滚的迁移编号。既有全局 ledger 仍只追加主迁移，特性账本不修改它。修改已发布特性 SQL 必须新增版本；历史 #4 升级库仍由原主账本拒绝，禁止手工改账本。本方案避免部署本分支后新增较早编号导致主 ledger 前缀不匹配。

创建频道先持久 creating，再调用 REST。未知结果只按本 guild/category/type/topic 标记核对，核对不到不再 POST；重复标记或不安全的 overwrite 不采用。删除前分页归档并排空已知 pending 输入，只删除精确托管频道；未知删除不盲重试。Discord 没有“与本地归档原子删除频道”的 API；最终检查与远端删除之间仍可能有有权 Staff 的写入，需测试服务器验收及 Staff 停止写入约定。

配置、命令、权限和实际验证边界见 [模块化集成](../DISCORD-MODULAR-INTEGRATION.md)。所有新增能力默认关闭，不发布、不部署、不操作真实 Discord。
