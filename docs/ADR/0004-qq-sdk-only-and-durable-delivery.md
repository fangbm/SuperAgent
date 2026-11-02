# ADR-0004：QQ SDK 边界与持久私聊投递

日期：2026-11-02。状态：已采用；已验证真实群 @ 接入与开发者单聊实际送达。

按用户指定先交付 QQ Source/Delivery；原里程碑编号保留，Discord/Steam 不在本轮。新增两个私有包和迁移 008，不修改 M0 冻结的 SDK、契约、Schema、fixtures 或默认配置。

平台适配器位于 connectors 路径，只依赖 SDK。Source 与 Delivery 是独立实例，互不共享 Host 能力。Core/Domain 不导入 QQ。平台无关的 plugin-host 负责持久发送意图、批准收件人作用域、不可变绑定摘要、请求幂等、租约及未知结果屏障。

实现官方签名 Webhook 与 Node 24 原生 WebSocket，不部署公网服务或引入平台 SDK。用户没有 HTTPS 回调，真实验收采用 WebSocket Identify/Resume、心跳与退避。仅在持久提交后推进恢复序列；失效 session 清除后重新 Identify，权限拒绝停止重连。Webhook 检查 AppID、原始请求字节签名、时间和来源范围，提交完成后 ACK。跨重启重复事件复用 Host ID。

伪名采用独立密钥 HMAC；检查点绑定伪名密钥、AppID 与作用域。更换绑定需新来源身份，防止旧检查点造成覆盖误判。没有历史补拉/编辑对账的源始终报告 partial/unknown，观察到 @ 事件不能证明全量能力。

单聊 provider 不尝试群发送。主动 POST 没有可靠平台幂等保证，超时/崩溃/损坏响应均为 unknown；不因格式权限拒绝自动再发另一格式。认证失败发生在消息 POST 前，可受预算地安全重试。报告键盘仅在 M5 的可信 Host token/回调存在时启用，不伪造可用动作或客户端送达。
