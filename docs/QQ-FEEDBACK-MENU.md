# QQ 群显式反馈与常驻管理菜单

## 配置和行为

唯一正式入口仍是 `pnpm start --config ...`。参考 [关闭状态示例](../examples/qq-feedback-menu/superagent.json) 与 [菜单模板](../examples/qq-feedback-menu/menu.json)。Source 的 feedbackCommands 和 Delivery 的 operatorMenu 分别启用；只采集不需要 Delivery 的 OpenID。模型须另行配置/授权，单独 M1 不运行模型。

群普通消息保留现有批处理。开头 `/bug 描述`、`/suggest 描述` 由 QQ Source 验证后单候选立即封批，不和普通开放 Segment 混合。空命令不调用模型；限流、超长仍归档，明确记录原因。用户命令不会强制分类、产生 P0 或向群里回复。

feedbackCommands 默认关闭。启用后默认：最大正文 4000 UTF-16 单元、同群引用上下文开启、60 秒固定窗每匿名用户 5、每群 30、项目 60；显式任务项目模型调用上限 120/窗。所有限额可配置，范围及单位见示例/Schema。模型调用仍受 analysis.maxCalls/maxInputCharacters 和统一并发约束，失败按现有重试与 dead_letter 处理。

图片仅有匿名引用及 MIME 元信息，没有下载/视觉分析；引用原文找不到或已删除则安全退化。模型提示明确区分正文、意图、原文和附件元信息。完整证据引用在 Domain 对不可变归档逐字验证。

operatorMenu 默认关闭，autoDeploy 只允许 false。开启后支持 `/pending` 待办、`/recent` 新增、`/menu` 或 `/more`、`/all-bugs`、`/all-suggestions`、`/history` 和 `/web`。原 `/reports`、`/bugs`、`/suggestions`、`/steam-negative`、`/open` 保留；旧报告查询仍是冻结窗口语义。

待办将 fixed 单列待验证，只列 candidate/reviewing 建议为待复核。全部 Bug 的总计、未处理、待验证、已终结分别按实际状态计数；全部建议将待复核与其他状态分开。待分析区分 pending/running/retry/failed/限流归档，不提前算作 Bug。新增显示明确窗口，只纳入该窗口内首次归档接收的有效来源反馈，也包含既有问题的新反馈；工作项晚创建、重复投递、重新匹配都不会将旧消息变成新反馈。最近反馈接收时间与工作项创建时间分别展示。显示反馈条数，非玩家人数。

列表/原文分页使用一小时有效的持久查询成员快照；详情状态与按钮现场授权、版本检查，读者没有写按钮。无新菜单 API 时仍能使用旧 C2C 命令；应用启动和查询不部署菜单。`webURL` 只允许无凭据、无 query/hash 的 HTTPS 公共工作台地址，打开后仍需 Web 自身登录和 CSRF。

历史报告采用数据库双向游标分页，无 100 份上限。首次打开时固定已封存范围，即使新报告或旧窗口的新修订在翻页期间写入，也不会挤动现有页面；“刷新历史”获取最新范围。旧版本仅带页码、没有新游标的历史按钮安全失效，可重新发送 `/history`，不修改任何报告快照。

历史分页索引通过同库特性迁移 workbench-v2 增加；已提交的 workbench-v1 SQL、哈希及主 Migration Ledger 不变，旧库保留数据并自动追加新索引。

## 原生菜单管理（需单独批准）

2026-11-05 已获用户独立批准，对真实 Bot 的空菜单执行一次 PUT，GET 读回版本 1；用户已确认客户端常驻、填入发送及交互回复正常，详见 [原生能力真实验收](QQ-NATIVE-ACCEPTANCE-2026-11-05.md)。QQ 官方 `send_message` 会把命令填入聊天输入框，用户需要发送。

```powershell
# 只读，保存可恢复的当前菜单快照；输出文件必须尚不存在
pnpm qq:menu --config config/superagent.json --delivery qq-developer-delivery --get --backup .artifacts/qq-menu-before.json
# 只读计划；显示 before/after Diff 与 approvalHash，不 PUT；也支持 --dry-run 仅输出计划
pnpm qq:menu --config config/superagent.json --delivery qq-developer-delivery --menu examples/qq-feedback-menu/menu.json --plan .artifacts/qq-menu-plan.json
# 人工审阅具体计划并明确批准后才能执行；不要直接照抄示例哈希
pnpm qq:menu --config config/superagent.json --delivery qq-developer-delivery --apply .artifacts/qq-menu-plan.json --approve REVIEWED_APPROVAL_HASH
# 超时/崩溃/结果未知：只读核对，不重发 PUT
pnpm qq:menu --config config/superagent.json --delivery qq-developer-delivery --reconcile OPERATION_ID
# 恢复也必须先生成新的计划，再独立审批和 apply
pnpm qq:menu --config config/superagent.json --delivery qq-developer-delivery --restore .artifacts/qq-menu-before.json --plan .artifacts/qq-menu-restore-plan.json
```

`--delivery` 使用实际配置 ID，示例文件中为 qq-management。工具只使用该 Delivery 的环境/DPAPI 凭据，不输出密钥。十分钟过期、旧版本变更、未审批、频率超限都拒绝写入。PUT 未知时不重试；可查询持久操作或恢复计划。恢复未设置过菜单的状态使用空 items。为防止无意分发凭据，本工具保守拒绝带 query/hash 的 link，既有此类菜单须先人工清理再使用本工具。

菜单故障不在应用服务生命周期内，不影响 M1/M3。单机账本仅覆盖使用同一数据库的受控工具调用；应对同一 Bot 使用同一管理数据库、串行维护窗口，避免外部管理端并发覆盖。

## 验证边界

实时查询的扩展性仍待评估。新增 [本地大数据量性能记录](QQ-LIVE-PERFORMANCE.md)：1 万条反馈的快照创建约 5.5–11 秒，5 万/10 万档首次待办查询超出 30 秒预算。该项保留为扩展性风险，尚未完成性能验收；1000+ 条稳定分页回归不能替代初始快照性能测量。

受控 QQ 签名 HTTP 回调、REST 替身、本机 HTTP 模型替身、真实文件 SQLite、实际子进程 SIGKILL 用于自动测试，不代替真实平台验收。2026-11-05 另已执行获批的真实菜单 PUT，当前客户端验收进展另记；本轮没有付费模型调用。详细事务、隐私、优先级和迁移决策见 [ADR 0020](ADR/0020-qq-explicit-feedback-and-native-menu.md)。

2026-11-05 两轮有界真实验收已完成以下四项，监听均已关闭，菜单获批保留。原生双事件同时推送、其他群授权、60 分钟最大回复时限、全部权限/审核/频控错误、回滚及长期负载仍未验证，不因本次通过而扩大结论。

| 真实 QQ 项目 | 当前状态 | 需要单独验证的内容 |
| --- | --- | --- |
| 群消息原生格式 | 指定验收群通过 | 真实全量事件中的手工/原生 @/引用指令、图片元信息、独立批次及同群引用；没有同时推送双事件证据 |
| 私聊底部常驻菜单 | 已批准设置、真实 API 读回及客户端常驻/填入发送通过 | 本轮批准保留菜单，未批准恢复；没有扩大到全部权限/频控场景 |
| 原生 `/` 指令面板 | 修复后真实新消息复测通过 | 原生面板自动 @，使用绑定群 bot_state 的 member_openid，与手工指令共用 Source/Ingress/M1 链路 |
| C2C 被动回复时限 | 即时回复及延迟 310.3 秒实际送达通过 | message/event 即时上下文、原消息 ID 的延迟被动发送已测；没有转主动发送，未测 60 分钟最大值 |

真实验收须限定具体账号、群/接收者、时间窗和读写预算。上述四项结论基于平台事件、持久数据库核对及用户客户端确认；两轮共 7 条发送，无群消息、模型调用或 GitHub 写入，不能扩大为整个项目或未测试场景均已验收。

官方核对：[菜单概览](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/menu-panel/)、[GET /v2/menu](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_menu.get.html)、[PUT /v2/menu](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_menu.put.html)。接口支持 C2C 全局菜单，一级最多 10 项、二级最多 5 项且不再嵌套；中文计 2 字符，一级名最多 10、二级最多 14。

原始开发本地验收：`pnpm install --frozen-lockfile`、完整 `pnpm check`（当时 414 项 Node 测试、6 组参考验证、构建/类型/边界/45 个冻结文件）、`pnpm test:m6`（76 项）通过。新增 59 项计数含子测试；实际 SIGKILL 覆盖归档后、Admission/Batch 事务中、已入队及 Worker 调用中。关闭示例 `--check-config` 通过。远端 Windows/Linux CI 结果以本功能 Draft PR 的当前 Head 为准。

本轮真实验收另修复空菜单响应、平台只读 icon 及群成员身份命名空间，新增 6 项回归；修复后的完整 `pnpm check` 为 **420 项 Node 测试、6 组参考验证通过**，没有修改 M0 冻结契约。真实结果、客户端确认和范围边界见上述原生能力验收记录。

2026-11-05 审查回归另覆盖：截止前接收/截止后分析、恰好截止边界的新反馈、全部列表真实状态计数、112 份历史报告双向翻页、翻页期间新增报告/修订的稳定范围、撤权/跨项目拒绝，以及 v1 → v2 索引升级不改旧账本。
