# 私有附件捕获与读取

PR B 依赖结构化报告 PR A。B 单独提交时默认关闭；用户后续要求在 PR C 默认开启附件能力，参考 `examples/qq-artifacts/superagent.json`。来源与 GitHub/Web 父开关仍须配置启用。

捕获需要 QQ Source 的 `config.captureAttachments=true` 和根 `artifacts.enabled=true`，当前缺省均为开启；显式 false 可关闭。通过 `artifacts.keyEnv` 指定保存妥当的 64 位十六进制（32 字节）密钥环境变量，默认 SA_ARTIFACT_KEY。未配置 artifacts 时 root 默认为 SQLite 同目录下 artifacts；主配置显式提供固定路径。全部相关平台关闭时无需附件密钥；使用附件存储时缺失密钥拒绝启动。root 为私有加密文件目录，不能每次启动重新生成密钥。错误密钥/目录会明确拒绝，不能靠覆盖文件恢复。此配置不自动启用模型或 QQ Delivery；GitHub 发布默认跟随已批准的 GitHub 父写入开关，详见 GITHUB-ISSUE-ASSETS.md。

默认每消息最多 5 文件、单文件 5 MiB、项目已保存文件 100 MiB、同时待捕获最多 100 条、下载票据 120 秒、下载 10 秒、最多 3 次尝试。配置上限见 application-config。PNG/JPEG/WebP、UTF-8 txt/log/json 及基本结构校验的 PDF/ZIP/DMP 可捕获，不解包、不执行；原生事件附件只存元信息，真实字节经受控下载、类型/大小检查与 SHA-256 后加密保存。过期、失败、拒绝有状态与错误码，不猜测已保存或已看图。

## 代理 Fake-IP 与 DNS

`artifacts.dnsMode` 可为 `system`（未配置时）或 `aliyun-doh`。随仓库提供的根配置选择后者，避免本机代理将 CDN 解析成 198.18.0.0/15 导致安全拒绝。DoH 只访问固定 `https://dns.alidns.com/resolve`，仅发送白名单 CDN 主机名和 A 查询，不发送原始附件路径、签名参数、账号标识或凭据；拒绝重定向、无效结果和超过 16 KiB 的响应。它不改变系统/其他插件的 DNS，也不允许用户配置任意 DoH URL。

两种模式均要求所有解析结果为公网地址，拒绝 Fake-IP/内网/保留地址，再将已验证地址固定到下载 TLS 连接并保留原主机名的证书检查。不会放行 198.18 地址或在私有结果上偷偷降级。需要系统解析的环境可显式设 `system`。真实群事件与 Fake-IP 排查记录见 QQ-ARTIFACT-ACCEPTANCE.md。

唯一正式入口仍为 `pnpm start --config ...`，附件后台循环与 M1/M3/M5 独立，原归档/Checkpoint 不改写。支持短链接票据的重启恢复及已落盘未确认的恢复；未归档事件不会触发网络下载，也不会阻塞其他已归档附件。

已登录的工作台用户可通过 `GET /api/artifacts/ARTIFACT_ID?project=PROJECT_ID` 下载本人当前有权读取的附件。未知 ID、跨项目、失效会话、撤权、已删除/陈旧来源均拒绝；响应强制下载、no-store、nosniff。这里只是同一受保护 Web 控制台的读取接口，未开放公网服务。

完整 `pnpm check`：513 项 Node + 6 组参考验证通过。新增八项真实本机 SQLite/文件与受控传输测试：先归档、加密及去重、恢复/过期/有限重试、精确来源、类型/大小/数量限制、DNS 固定与重定向拒绝、QQ 签名接入、Web 会话/项目/撤权和关闭。没有真实 QQ CDN 下载、GitHub 文件上传或图片视觉分析；PR C 将直接接 GitHub Issue 附件与迟到更新。

上述为 B 单独提交时的验收边界。C 后续完整检查为 531 项 Node + 6 组参考验证，并于 2026-11-05 20:01 完成真实验收群 JPEG 下载、加密落盘、来源映射和授权读取；见 QQ-ARTIFACT-ACCEPTANCE.md。GitHub 原生合成 PNG 已独立验收，普通日志上传遭平台 422 拒绝，未做图片视觉分析或 Claude Code 联调。

最新 C 后续已增加独立跨消息附件归属、工作台确认和原生普通文件网页上传，合成 TXT 已在私有测试 Issue 真实引用并通过权限/哈希读回，全量 546 项 Node + 6 组参考验证通过。跨消息关联不新增独立反馈数，详见 CROSS-MESSAGE-ATTACHMENTS.md；上面的 422 属于图片 token 端点，不再代表普通文件网页上传的当前结果。
