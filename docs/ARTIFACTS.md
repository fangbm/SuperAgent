# 私有附件捕获与读取

PR B 依赖结构化报告 PR A。参考 `examples/qq-artifacts/superagent.json`，默认所有来源、下载和外部写入关闭。

要启用捕获，需要同时设置 QQ Source 的 `config.captureAttachments=true`、根 `artifacts.enabled=true`，并通过 `artifacts.keyEnv` 指定一个保存妥当的 64 位十六进制（32 字节）密钥环境变量。root 为私有加密文件目录，不能每次启动重新生成密钥。错误密钥/目录会明确拒绝，不能靠覆盖文件恢复。此配置不自动启用模型、QQ Delivery 或 GitHub 上传。

默认每消息最多 5 文件、单文件 5 MiB、项目已保存文件 100 MiB、同时待捕获最多 100 条、下载票据 120 秒、下载 10 秒、最多 3 次尝试。配置上限见 application-config。PNG/JPEG/WebP 和常见 UTF-8 txt/log/json 可捕获；原生事件附件只存元信息，真实字节经受控下载、类型/大小检查与 SHA-256 后加密保存。过期、失败、拒绝有状态与错误码，不猜测已保存或已看图。

唯一正式入口仍为 `pnpm start --config ...`，附件后台循环与 M1/M3/M5 独立，原归档/Checkpoint 不改写。支持短链接票据的重启恢复及已落盘未确认的恢复；未归档事件不会触发网络下载，也不会阻塞其他已归档附件。

已登录的工作台用户可通过 `GET /api/artifacts/ARTIFACT_ID?project=PROJECT_ID` 下载本人当前有权读取的附件。未知 ID、跨项目、失效会话、撤权、已删除/陈旧来源均拒绝；响应强制下载、no-store、nosniff。这里只是同一受保护 Web 控制台的读取接口，未开放公网服务。

完整 `pnpm check`：513 项 Node + 6 组参考验证通过。新增八项真实本机 SQLite/文件与受控传输测试：先归档、加密及去重、恢复/过期/有限重试、精确来源、类型/大小/数量限制、DNS 固定与重定向拒绝、QQ 签名接入、Web 会话/项目/撤权和关闭。没有真实 QQ CDN 下载、GitHub 文件上传或图片视觉分析；PR C 将直接接 GitHub Issue 附件与迟到更新。
