# QQ 官方文档核对与修正

2026-11-03，按用户指定的 [API v2 官方文档](https://bot.q.qq.com/wiki/develop/api-v2/)核对。以当前接口文档为准，SDK 只补充 ACK 请求头等实现细节。没有修改 M0 冻结文件或对外 SDK。

| 官方依据 | 实现与验证 |
| --- | --- |
| [通用 Payload](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/payload.html)、[单聊发送](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html) | Source 保留外层 `payload.id`，用它填写被动回复 `event_id`；不再把互动体内的 UUID 当作回复事件。 |
| [互动响应](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/interactions_interaction_id.put.html) | ACK 的路径参数使用 `d.id`，与发消息的事件 ID 分开。补上官方 SDK 的 `X-Callback-AppID` 头，支持空成功响应。先持久接收，再 ACK。重复推送不再次 ACK 或创建回复。 |
| [互动事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/interaction_create.html) | 仅处理消息按钮 type 11，订阅 intent 26；其他互动不被误作按钮。强制核对开发者 OpenID、C2C 场景和 AppID。 |
| [调用指南](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html)、[访问凭证](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html) | 解析业务 `err_code`，同时兼容凭证接口的 `code`；HTTP 200 带业务错误不会误判成功。未知或冲突码保持保守结果，错误文本不进入日志。 |
| [消息按钮](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/msg-btn.html) | C2C 使用 type 2 点击权限，业务权限由服务端白名单与令牌核对；补兼容提示。标签限制 10 字符，行列保持低于官方上限。不使用已弃用的点击次数字段。 |
| [单聊消息事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html) | 同一个消息 ID 的控制命令结合 `message_scene.ext` 内的 `msg_idx` 去重；不保存该扩展中的鉴权令牌。同一入站消息的回复序号递增，最多 4 次。 |
| [WebSocket](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html) | 频道默认只订阅公域 @ intent 30；私域全量 intent 9 须显式设置 `channelMessages:'all'`。群/C2C 仍使用 intent 25。 |

控制回复必须有合法的被动上下文。缺失时在 POST 前阻止，不自动改成主动消息。之前为绕开 UUID 错误而临时使用主动回复的做法已撤销。相同交互的重放不会替换原有回复上下文或重开旧外部操作；新内容冒用旧交互 ID 仍被拒绝。ACK 首次持久接收后只尝试一次，崩溃或网络故障可能留下客户端未确认的点击，不声称有平台端的恰好一次保证。

单聊文档对有效期有两处不同表述（概述 60 分钟、参数说明 5 分钟），实现不据此扩大窗口，也不在被动回复过期后自动转主动发送。平台明确拒绝只记录为拒绝；超时、断连和不明结果继续使用 unknown 屏障。

本地 HTTP 联测已从签名回调实际经过 Source → 持久收件箱 → ACK → 领域只读详情 → C2C POST，分别校验 ACK UUID、外层回复事件 ID、字段互斥、兼容提示及重复回调。另有 `err_code`、消息索引、频道 intent 和缺失上下文测试；完整检查结果见 [M5 验收](M5-ACCEPTANCE.md)。这些属于本地协议模拟，不替代最终被动回复和原文在 QQ 客户端的验收。

首轮真实历史：报告已由用户确认收到，列表及两条详情获接口受理；一次详情因旧 UUID 参数被 HTTP 400 明确拒绝。ACK 的实际 HTTP 200 已记录。受理合计 4 条后停止，剩余一条未处理点击取消并留档。用户随后要求复测：文档版三步被动链路各一次 accepted，原文已实收。底部分页由纯文本命令改为字面 Markdown 加原生键盘，两页再次实测 accepted，用户确认按钮与原文均正常。原文不改写；仅发送层转义格式字符，未知结果仍不重发。完整分轮证据见 [M5 验收](M5-ACCEPTANCE.md)。
