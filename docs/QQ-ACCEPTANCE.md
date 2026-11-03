# QQ 代码与真实验收

后续更新：2026-11-03 已验证指定真实用户群和验收群的普通 `GROUP_MESSAGE_CREATE`、自动批处理与真实模型调用；独立反馈计数和建议匹配说明修订后，保存的真实样例已通过真实模型复测，计数正确、建议关联原条目且无需复核。旧复核副本保留。详见 [主链路验收](QQ-MAINFLOW-ACCEPTANCE.md)。下文保留 11月2日首轮范围，不能将其历史“尚未验证”当作当前全部状态。

日期：2026-11-02。用户指定先做 QQ（原设计为 M2，不等于完成 Discord/Steam 的 M4）。状态：**代码、本地验证、真实群 @ 接入和开发者 Markdown 私聊实际送达均已验证**。群全量权限、报告/操作回调不在本次已通过范围。

## 交付与本地检查

新增 `@superagent/qq-official` 和 `@superagent/plugin-host` 两个私有包、迁移 008、Source/Probe/Send-Test 命令以及本机 DPAPI 配置工具。Source 支持官方 WebSocket Identify/Resume、心跳和退避，也支持签名 Webhook。平台连接器仅依赖 SDK；持久发送由 Host 持有。绑定摘要防止来源/收件人引用被静默改绑，消息和恢复序列同事务提交，超时/崩溃转 unknown。

`pnpm check` 在 Windows / Node 24.4.0 / pnpm 11.0.8 下通过：十五个包构建、类型正反例、依赖/私有边界、45 文件冻结检查、**138 个 Node 测试、6 个 Python/SQLite 参考套件**。新增 29 个测试，包括 SDK 边界、Ed25519 官方挑战向量、伪造/过时回调拒绝、重复回调、失败不 ACK、来源隔离与脱敏、实际 CLI/本地 HTTP、Gateway 心跳/Resume/无效 session、提交失败不推进序列、权限拒绝、真实子进程终止后 unknown、DPAPI 加密配置等。

自动化测试中的平台/模型响应均为本地模拟。真实平台结果见下节，没有混为模拟成功。

## 真实官方账号

使用用户提供的官方凭据，通过真实凭证接口、`/users/@me` 和 `/gateway`。认证成功，返回 WSS 网关 `api.sgroup.qq.com`。用户没有 HTTPS 回调，因此使用原生 Node 24 WebSocket，实际完成登录与接收，没有部署公网服务。

用户给出的群号/个人 QQ 号没有当作 API OpenID。通过两个一次性挑战消息，分别从真实群和开发者 C2C 事件取得 OpenID。其他群/私聊消息未进入分析库。用户提供的短伪名密钥未使用，生成独立 32 字节随机值；凭据和绑定存为 `.artifacts/qq-config.dpapi`，由 Windows 当前用户 DPAPI 加密，未进入 Git。

## 真实入站

项目/来源为 `game-qq-live` / `qq-live-group-01`，数据库 `.artifacts/qq-live.sqlite`。用户在测试群 @机器人发送指定崩溃样例后：

- 接收 `GROUP_AT_MESSAGE_CREATE`，规范化消息与检查点均已持久化，样例标记匹配。
- M1 admission 完成，按默认 60 秒静默窗口自动生成一个批次，没有手动 flush 或修改默认策略。
- 对应 `feedback.batch.triage` 为 pending；此数据库没有启动模型 worker，**不声称已分析这条真实 QQ 消息**。
- coverage 为 partial，原因 `QQ_MENTIONS_ONLY_OBSERVED_NO_HISTORY_OR_EDITS`。没有证明全量群权限。

## 真实私聊

用户明确批准向绑定开发者发送一条固定消息，标题 `[QQ 验收] SuperAgent 私聊链路`。先准备草稿，再执行 `--send`，真实 API 接受 Markdown。

操作 `external-fba986ef9e8ed910ba5b6f0880106a73364a12c9af026e1d99d424ac55fbea36` 为 succeeded，结果 accepted，尝试次数 1。用户随后明确回复“已实际收到”。本次同时有 API 受理和客户端送达确认，不推断已读。没有群发送、自动重发或额外测试消息。

## 证据与边界

脱敏结果见 [qq-live-2026-11-02.json](evidence/qq-live-2026-11-02.json)。原始入库证据、检查点、批次和投递操作保留在 Git 忽略的 `.artifacts/qq-live.sqlite`；不要提交配置或数据库。

没有完成全量群授权、历史补拉、群/C2C 编辑对账、附件下载/OCR、Discord/Steam、M5 报告/Web/按钮动作、P0 调度或公网 HTTPS 部署。真实平台限流、断网/重复推送故障注入、真实 Webhook 挑战和大规模运行尚未验收；本地测试不能代替这些证据。Keyboard 需 M5 的可信 Host token/回调，本轮没有实际启用或宣称按钮可用。
