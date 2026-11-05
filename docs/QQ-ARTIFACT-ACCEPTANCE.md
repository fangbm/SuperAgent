# QQ 附件捕获验收（2026-11-05）

本轮是 PR #17 附件功能后续真实平台验证，只绑定此前 QQ45B 验收群；不混用真实用户群配置。无群消息发送、QQ 私聊回复、模型调用或本轮图片的 GitHub 上传。

## 消息与边界

用户首张图片发在私聊，群 Source 没有收到是预期边界，不能记为群接收成功。19:33 首窗口到期正常停止。用户随后在测试群重发，19:35 使用原有 Checkpoint/会话恢复，补收到一条匹配目标群的 GROUP_MESSAGE_CREATE：message_type=0、顶层 attachments 一张 image/jpeg，HTTPS 主机 multimedia.nt.qq.com.cn。Source 通过冻结 Host 归档原事件、绑定精确 assetRef；未匹配群的事件忽略，不入库。

## 首次下载与修正

本机系统解析与指定公共 UDP DNS 均返回 198.18.0.156（代理 Fake-IP），原有公网地址校验以 ARTIFACT_ADDRESS_NOT_PUBLIC 拒绝，保留 unavailable 和原事件，清除临时票据。没有伪造 stored、重置 Checkpoint、放行保留地址或重写失败记录。

固定 DoH 查询得到公网 A 记录，保持原 CDN 主机名的 TLS 固定地址连接已实际建立。新增受控传输测试覆盖查询不泄漏附件 URL、无凭据、固定公网地址、Fake-IP/内网拒绝、响应长度/JSON/重定向与关闭边界。根配置选择 aliyun-doh，其他应用可选 system；详见 ARTIFACTS.md。完整 pnpm check：531 项 Node + 6 组参考验证通过。

旧失败票据已清除，20:00 窗口到期时尚无新图，按期停止。用户要求重开后，20:01 使用同库、同密钥和原 Checkpoint 恢复，设定最多至 20:21；没有修改旧失败状态或回退 Checkpoint。

## 修复后真实图片验收：通过

20:01:49 已收到测试群新 JPEG 并完成下载/加密保存，随后自动停止监听，未继续等待窗口结束。20:02:35 在关闭的验收库上重新打开存储进行授权读取与完整性核验：

- 新附件状态 stored，image/jpeg，98,552 字节；SHA-256 为 `57971e5455c8d56fac6f2398d7e7b551d0025655b8ee8dd0036f0b872ee52f0d`。
- 对应 source_event_id + assetRef 与已归档的原消息完全一致；临时 URL/签名未进入事件的附件元信息。
- 落盘为加密字节，授权读取解密后的长度/哈希与记录一致；跨项目读取和撤权回调均拒绝。
- 临时下载票据已清除；重开后 tick 无待下载任务，没有再次请求 CDN。
- 库内 2 条归档消息：首次被 Fake-IP 拦截的原图记录保留 unavailable，新图独立 stored；不伪造原记录恢复。成功附件共 1 个。
- 本轮模型调用 0、GitHub 写入 0、QQ 群发送 0。未将这张 QQ 实图上传到 GitHub，也未进行图片视觉分析或 Claude Code 读取。

本轮证明真实 QQ 群图片→Archive-first→受控 CDN 下载→同库精确关联→加密保存→授权读取；GitHub 原生图片上传的独立实测见 GITHUB-ISSUE-ASSETS.md，不能把两轮相加称为这张图片的完整 GitHub/Claude 联调。

本机忽略目录证据：.artifacts/qq-artifact-live-20261105-r2/result.json、verification.json、state.sqlite 和 DPAPI 保护的独立验收密钥；前一超时窗口单独保存 result-window-ended-20261105-2000.json。原 OpenID、签名 URL、图片原字节与密钥不提交 Git。
