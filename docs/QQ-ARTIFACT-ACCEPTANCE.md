# QQ 附件捕获验收（2026-11-05）

本轮是 PR #17 附件功能后续真实平台验证，只绑定此前 QQ45B 验收群；不混用真实用户群配置。无群消息发送、QQ 私聊回复、模型调用或本轮图片的 GitHub 上传。

## 消息与边界

用户首张图片发在私聊，群 Source 没有收到是预期边界，不能记为群接收成功。19:33 首窗口到期正常停止。用户随后在测试群重发，19:35 使用原有 Checkpoint/会话恢复，补收到一条匹配目标群的 GROUP_MESSAGE_CREATE：message_type=0、顶层 attachments 一张 image/jpeg，HTTPS 主机 multimedia.nt.qq.com.cn。Source 通过冻结 Host 归档原事件、绑定精确 assetRef；未匹配群的事件忽略，不入库。

## 首次下载与修正

本机系统解析与指定公共 UDP DNS 均返回 198.18.0.156（代理 Fake-IP），原有公网地址校验以 ARTIFACT_ADDRESS_NOT_PUBLIC 拒绝，保留 unavailable 和原事件，清除临时票据。没有伪造 stored、重置 Checkpoint、放行保留地址或重写失败记录。

固定 DoH 查询得到公网 A 记录，保持原 CDN 主机名的 TLS 固定地址连接已实际建立。新增受控传输测试覆盖查询不泄漏附件 URL、无凭据、固定公网地址、Fake-IP/内网拒绝、响应长度/JSON/重定向与关闭边界。根配置选择 aliyun-doh，其他应用可选 system；详见 ARTIFACTS.md。完整 pnpm check：531 项 Node + 6 组参考验证通过。

旧失败票据已清除，因此重新开启至 20:00 的窗口，等待用户新图片提供有效短链接。到新图完成前，只能确认真实群接收/归档和 DNS/TLS，不能宣称实际图片下载、加密保存及读取已通过。

本机忽略目录证据：.artifacts/qq-artifact-live-20261105-r2/result.json、state.sqlite 和 DPAPI 保护的独立验收密钥。原 OpenID、签名 URL、图片原字节与密钥不提交 Git。
