# ADR 0020：QQ 显式反馈、实时查询与原生菜单

2026-11-04。基于 main d9937a9；#9/#10/#11–#13 仍为独立 Draft。本次不依赖它们，不恢复旧 Discord 功能，也不实现第二套 P0 调度。

## 可信意图与事务

QQ Source 只解析已认证、绑定群的 created 消息。开头完整 `/bug`、`/suggest` 大小写不敏感；仅允许 Unicode 空白和现场 `/users/@me` 验证的 Bot 原生 mention。代码块、引用、正文中间、其他人的 mention 和外来元数据都不会触发。群指令菜单填入的文本与手工文本共用解析器，不将菜单元数据当权限。

Source 在现有允许的 attributes 中保存类型和 UTF-16 正文范围；仍归档完整规范化文本、匿名作者、群/来源、消息身份、附件引用和回复关系。既有 QQ 原生身份匿名化及 CDN Token/签名剥离不变。附件匿名引用改为原消息/序号/文件名/MIME 的稳定身份，避免临时签名轮换改变身份；可信 QQ 重复观察可兼容旧引用及已验证的 Bot 前缀呈现差异，但不覆盖第一份归档，正文/作者/时间/对象/附件类型等冲突仍拒绝。内部 Event ID 仍由 Ingress 分配。

可信 Registry 初始化器单独向 Ingress 注册 QQ 绑定及配置；Ingress 同时复核平台/来源、正文前缀和范围，只有该绑定可在与原文相同事务内建立 `qq_explicit_feedback` 记录。M1 不直接相信任意 attributes。其他平台伪造属性没有资格。若第二个已认证 @ 观察补足资格，意图映射回第一份原文；未封批的普通候选在 Admission 事务中移出原 Segment 并独立封批，空 Segment 安全清理，其他普通候选保留。已封批事件只记 QQ_EXPLICIT_ALREADY_BATCHED，不再次分析。

有效命令的 Admission、固定窗限额认领、单候选 Segment、Batch 和 triage 入队在同一 SQLite 事务完成。显式 Segment 不参与普通 flush 合并，quiet_due_at 立即到期，复用冻结的 quiet_timeout 原因；内部 rationale 记录 QQ_EXPLICIT_IMMEDIATE。空、超长和限流保留归档及具体原因，不声称完成分析。命令本身从不生成 urgent_candidate 或 P0。

M3 复用原 Worker/模型预算/提取/匹配/Domain/Evidence 校验，使用正文投影及不可变原文；命令是玩家意图，不是可信分类或严重程度。附件只提供无敏感 URL 的元信息，明确 contentAnalyzed=false，不声称已读图。引用仅同项目、同 Source、同群的可见原文，最多受现有 context 上限约束；Context 不计独立反馈。

## 调度与预算

显式任务 priority=50，普通仍为 0，高危旧逻辑仍为 100。相同 full_agent lane 内由同一 AnalysisWorker 持久记录短 burst，每三次高优先级取一项可执行普通任务；重启不重置配额。未创建线程池或 Worker。

用户、群和项目固定窗限额均用匿名身份/来源持久化。`maxModelCallsPerWindow` 限制显式任务可使用的项目模型调用量，统计包括普通项目调用；缓存命中不计新调用。现有 maxCalls、输入预算、取消、租约和最大重试仍适用，耗尽可进入 dead_letter，需人工核对或显式重分析；不伪装成功。

## 实时查询与原生菜单

菜单只是全局 C2C 导航。官方 send_message 是填入输入框，不保证点击即自动发送；待用户发送后走现有 C2C 路由。没有虚构菜单 Interaction 类型。按钮仍使用 type=11、d.id ACK 与外层 payload.id 被动回复。

实时查询不创建 ReportV2。单次 SQLite 快照以有界 keyset 读页建立持久成员列表，之后按 ordinal 主键分页，避免新数据推移页面。数据/原文成员锚定到查询时刻；详情状态和每个按钮再次执行当前项目授权、状态版本与审计。查询一小时过期后须刷新，绝不修改半日报。

新增窗口为最新封存报告 endExclusive 到查询时间，无报告默认 24 小时，可配置 1–168 小时。新反馈以有效 primary 来源对象首次接收时间去重，不用重新提取/匹配时间冒充新消息。按现有独立来源对象语义显示“条”，不虚构玩家人数。当前 main 没有经批准的正式严重程度等级，列表按最近活动、稳定 ID 排序，不凭文本生成 P0/P1/P2。

全局菜单可见不代表授权。保留单开发者 OpenID 绑定，reader/developer 及项目权限不重写。未知/撤权 C2C 只允许固定、无项目内容的被动拒绝；默认随菜单/Delivery 写入关闭，开启后有匿名限额和先认领再发送，未知不重发。群内不发送任何确认或结果。

## 菜单运维与迁移

应用启动不调用菜单 API。独立工具 GET 30 QPM；PUT 本地限制最多 4 QPM、至少 15 秒。计划含旧版本/完整配置、新配置、Diff、十分钟有效期及审批哈希；只有对应审批才能 PUT。写前记录旧快照及 in_flight，成功/未知/拒绝持久化。相同计划不会重复 PUT，未知仅 GET 核对；恢复旧菜单也要新计划和审批。官方无条件 PUT，GET 到 PUT 间的外部修改竞态无法消除，需要维护窗口与人工核对。

同一主 SQLite 增加 `qq_feature_migrations` 独立哈希账本和版本 SQL，不占用并行 #10 的主 Migration 013，也不改历史迁移或 M0 冻结文件。仅增加内部索引/状态，旧配置可直接启动；禁用后已归档指令及工作项保留。账本不匹配拒绝启动，不静默重写。
