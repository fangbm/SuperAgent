# QQ 官方机器人接入

本轮按用户指定优先做 QQ。原 v0.9 的 QQ 对应 M2，M4 是 Discord/Steam；此次不把其他平台或 M5 报告/交互页面算作完成。

## 结构与权限

`packages/connectors/qq-official` 只依赖插件 SDK，提供独立的 `QQSource` 和 `QQC2CDelivery` 实例与 manifest。Source 只有入库、健康和指定密钥权限；Delivery 只有指定开发者私聊发送权限，没有群发送接口。持久发送意图和结果由 `packages/plugin-host` 持有，平台插件不读数据库或领域服务。

Source 支持官方 WebSocket 和 HTTPS Webhook。WebSocket 负责 Identify/Resume、心跳确认、断线退避和无效会话恢复，仅在 Host 持久提交后推进序列。Webhook 支持 AppID 检查、Ed25519 原始字节签名、时间窗、op=13 挑战、op=12 确认。启动和认证探针都不证明拥有全量群消息或主动 C2C 权限。

支持范围：绑定的群 `GROUP_AT_MESSAGE_CREATE` / `GROUP_MESSAGE_CREATE`、子频道 `AT_MESSAGE_CREATE` / `MESSAGE_CREATE` 和频道撤回事件，或显式绑定的单个 C2C 对象。一实例只绑定一个内部项目/来源和一个平台对象；不在范围内的事件、机器人回声和其他事件类型不进入分析。默认群模式不会把开发者私聊控制消息作为玩家反馈。

只有 `commitBatch` 成功后才确认消息。来源平台对象、AppID 或伪名密钥改变后不能沿用原来源检查点，须使用新的 sourceId。同一来源只运行一个主动实例；SDK v1 没有分布式配置变更 CAS。

检查点保存绑定摘要、最后一次观察信息和 WebSocket 恢复 sessionId/已提交序列，不保存 AppSecret、AccessToken 或原始 OpenID；恢复 session 不进入模型。用户、消息对象、会话、提及和附件引用使用按来源隔离的 HMAC 标识；`message_scene.auth_token`、签名 CDN URL 和卡片内部数据不进入 Core/LLM。普通正文不重写，提及中的平台 ID 会伪名化；证据对应这个规范化版本，不是未脱敏的平台原始报文。

群全量和仅 @ 分别记录观察原因。即使收到全量事件，因没有历史补拉和编辑对账，coverage 仍为 partial。附件只保留类型和不透明引用，未下载、OCR、转写或提供原文件查询。断连期间消息能否补推取决于平台，不能宣称零丢失。

## 本地配置与启动

在运行脚本的进程环境中设置以下变量；不要把真实值提交到 Git：

| 环境变量 | 用途 |
| --- | --- |
| `SA_QQ_APP_ID` | 官方机器人 AppID |
| `SA_QQ_APP_SECRET` | AppSecret/Bot Secret |
| `SA_QQ_SCOPE_ID` | 绑定群 OpenID、子频道 ID，或显式的 C2C OpenID |
| `SA_QQ_PSEUDONYM_KEY` | 至少 32 字节的随机密钥；同一来源长期保持稳定 |
| `SA_QQ_DEVELOPER_OPENID` | 已批准的开发者单聊 OpenID，与群成员 OpenID 用途不同 |

应用不会自动加载 `.env`。也可由用户在 Git 忽略的 `.env.local` 配置，再显式执行 `node --env-file=.env.local scripts/qq-probe.mjs ...`。不要使用会把凭据打印到聊天或日志的排障方式。

本机真实验收已通过一次性挑战消息获得真实 OpenID，未把群号或个人 QQ 号作为 API 收件地址。配置保存在 `.artifacts/qq-config.dpapi`（Windows 当前用户 DPAPI 加密、Git 忽略），伪名密钥为新生成的 32 字节随机值。启动时显式添加 `--protected-config .artifacts/qq-config.dpapi`，不会自动发现或打印凭据。该文件不能直接搬到另一 Windows 用户使用。

```powershell
pnpm install --frozen-lockfile
pnpm build
# 只认证并读取本地观察，不发送消息：
pnpm qq:probe --database .artifacts/qq.sqlite --project game-01 --source qq-test --kind group
# 本地接收；管理员配置 HTTPS 反向代理到这个 loopback 地址：
pnpm qq:source --database .artifacts/qq.sqlite --project game-01 --source qq-test --kind group --port 8080
# 无 HTTPS 时，改用官方 WebSocket；本机已验收配置的重启命令：
pnpm qq:source --database .artifacts/qq-live.sqlite --project game-qq-live --source qq-live-group-01 --kind group --transport websocket --protected-config .artifacts/qq-config.dpapi
```

Webhook 回调路径 `/qq/events`，健康路径 `/health`。脚本仅监听 `127.0.0.1`，不会建立公网隧道、修改平台后台或部署 HTTPS 服务。WebSocket 模式不需要 HTTPS 回调，入站 HTTP 事件被禁用。Webhook 模式的官方回调端口支持 80/443/8080/8443，生产入口必须是 HTTPS。在 QQ 后台选择确有授权的事件类型，普通群 @ 不能代表全量群权限。

Source 脚本每秒推进已有 M1 admission/buffer；真实模型分析另运行已配置的 `worker:m3`，可使用同一 SQLite 数据库。退出时停止 admission、关闭 HTTP 并释放数据库。Windows 强制结束场景按崩溃恢复处理。

2026-11-03 已在真实用户群收到普通 `GROUP_MESSAGE_CREATE`，真实等待默认 120 秒最长窗口后合批并完成模型调用；验收群也验证了 60 秒静默合批。真实用户群绑定单独存于 `.artifacts/qq-user-group-20261103.dpapi`，`.artifacts/qq-config.dpapi` 仍属于此前验收群，启动时须明确选择。当前监听是临时验收，已关闭；原文与计数修订问题见 [主链路验收](QQ-MAINFLOW-ACCEPTANCE.md)。

## 私聊投递

```powershell
# 默认仅创建本地固定验收草稿，不调用发送接口：
pnpm qq:send-test --database .artifacts/qq.sqlite --project game-01
# 用户明确允许后，仅向绑定开发者发送一条固定 Markdown 测试消息：
pnpm qq:send-test --database .artifacts/qq.sqlite --project game-01 --send
```

固定标题：`[QQ 验收] SuperAgent 私聊链路`。正文：`这是一条测试消息，用于验证官方机器人开发者私聊发送权限。接口受理不代表已读，请在 QQ 客户端确认是否实际收到。`

默认 Markdown；`--format text` 明确选择纯文本。这是另一个验收操作，不能当作 unknown 的自动降级重试。成功只表示 QQ 接口受理，仍须接收者在客户端确认实际收到。键盘渲染支持固定快照的三个导航动作，但仅在可信 Host 提供不透明操作 token 和相应 M5 回调处理时启用；目前 CLI 不安装 M5，因此只发正文并提示交互导航未启用，不展示无效按钮。

验收脚本每项目/格式只有一个稳定操作键。已成功、blocked、unknown 的操作不会自动再发；同一收件人引用的绑定摘要改变会拒绝启动。普通报告必须引用本项目已封存的报告修订，不能用此入口绕过报告调度发送非 P0 即时通知。P0 的独立发送扩展和通知调度没有在本轮启用。

发送前原子写 intent、请求快照和尝试记录；终态与本地映射原子提交。权限拒绝为 blocked；超时、5xx、响应损坏、未知业务码、发送进程崩溃为 unknown，不盲目重试、不自动切换格式。只有已证实消息 POST 尚未发生的认证失败才 safe_retry，最多三次；当前没有假设 QQ 提供可靠的主动消息请求幂等或查询接口。错误只记代码，不输出平台原始错误、Token、OpenID。

## 接口依据

2026-11-03 按用户指定的 API v2 官方文档重新核对了 ACK、外层回复事件 ID、业务错误码、消息索引去重和频道 intents。修正清单、本地协议联测与真实证据边界见 [QQ 文档核对](QQ-PROTOCOL-AUDIT-2026-11-03.md)。M5 查询回复缺失被动上下文时会阻止发送，不转主动消息。

见 [QQ 验收记录](QQ-ACCEPTANCE.md)。真实账号权限、HTTPS 回调可达性和客户端实际送达必须单独记录；本地 HTTP 模拟和认证成功都不能替代这些证据。

官方文档（2026-11-02 查阅）：[访问凭证](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)、[Webhook](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html)、[WebSocket](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html)、[签名算法](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html)、[通用 Payload](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/payload.html)、[全量群消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html)、[单聊发送](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)。API 与凭证默认域名为 `api.bot.qq.com`；本机真实请求返回的网关主机为 `api.sgroup.qq.com`，两个平台主机均列入 Source 声明。实际账号权限以联调为准。
