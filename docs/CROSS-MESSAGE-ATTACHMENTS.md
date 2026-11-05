# 分开发送的图片、日志与文件

PR #17 在统一入口中默认运行附件归属处理，不需另开 worker；QQ/GitHub 平台父开关和写入授权仍须配置。

| 消息关系 | 当前处理 |
| --- | --- |
| 文字和附件在同一消息，且只提取出一条有效反馈 | 自动关联 |
| 图片/文件引用回复原反馈，且目标唯一 | 自动关联，中间其他人的消息不影响 |
| 同一人分开发送、未引用 | 在同会话前后 5 分钟找候选，工作台确认后才发布 |
| 多条可能目标、不同作者未明确引用、没有有效文字反馈 | 不猜测；待确认/待产生反馈 |
| 原附件或目标反馈失效、删除、撤销 | 后续报告/发布不再纳入；不改写原消息和历史报告，不承诺删除已发布的历史附件 |

工作台新增“附件关联”：查看来源文字、文件保存与 GitHub 发布状态，下载原件、选择反馈并填写理由，确认或拒绝。只读账号只能查看。附件关联不会增加独立反馈数；没有图片视觉/OCR/文件语义分析。确认归属不等于已验证文件内容。

## 普通文件上传配置

现支持 PNG/JPEG/WebP、UTF-8 TXT/LOG/JSON，以及按基本结构检查的 PDF/ZIP/DMP。默认单文件上限仍为 5 MiB。图片使用 GitHub token；普通文件须额外配置网页登录上传会话。

在已登录 GitHub 的 Chrome/Edge，F12 → Application → Cookies → https://github.com，手工复制 user_session；不要贴聊天。进入实际运行的 checkout，然后执行：

```powershell
pnpm github:session --config config/superagent.json
pnpm github:session --config config/superagent.json --check
```

第一条隐藏输入并保存 DPAPI 密文，第二条只显示是否已配置和密文路径，不输出会话、不访问 GitHub。默认密文在该配置 SQLite 同目录下 github-upload-session.dpapi；实际应用自动读取同一路径。可在 github.attachmentUploads 指定 sessionConfig（相对配置目录）或 sessionEnv（由本机安全注入），不能同时配置两者。非 Windows 环境使用显式环境变量，不读取 Windows 密文。

没有配置时，普通文件保留 waiting_configuration，图片不受影响，不重复请求已知拒绝普通文件的图片端点。会话过期需重新配置；unknown 不自动重传。不会自动提取浏览器 Cookie、升级 gh 或启动真实群监听。

## 验证

完整 `pnpm install --frozen-lockfile` 与 `pnpm check` 通过：546 项 Node 测试、6 组参考验证，包含构建/类型/依赖边界/45 个冻结文件检查。相对 531 基线新增 15 项回归。

跨消息引用、插话、同作者候选、图片先于文字的时间顺序、歧义/跨会话/删除拒绝、人工撤销/恢复、独立反馈数不变，以及 HTTP/CSRF/角色/令牌/分页/实际页面 DOM 确认与拒绝已做受控测试。浏览器连接因当前环境的 trusted native bridge 不可用，未计作真实浏览器视觉验收。

2026-11-05 21:59—22:00，私有 fangbm/sa-test 原生 TXT 上传实测通过：124 字节合成日志，SHA-256 `595cdced88cdc63459c20141b2dbeb237e79fa14048bb8b98a31ff5d6949b7de`。已在 [测试 Issue #5](https://github.com/fangbm/sa-test/issues/5#issuecomment-6658664559) 引用，引用后授权读取同哈希、匿名拒绝再次通过。前两次策略校验在任何文件字节发送前拒绝了未列入允许范围的新网关；修正精确桶路径后仅发送一次文件。没有自动重试未知上传，没有上传用户 QQ 图片、群消息发送或真实模型调用。

PDF/ZIP/DMP 的捕获类型检查和普通文件策略由受控接口验证，尚未逐类型真实上传；QQ 分开发图/引用回复的本轮真实平台联调尚未做。之前单条 QQ JPEG 下载保存的实测见 QQ-ARTIFACT-ACCEPTANCE.md，两者不混写。

会话密文、上传策略和本机结果均在 Git 忽略目录，凭据不进源码或 PR。本机真实文件结果见 .artifacts/github-file-live-20261105-r3/result.json；先前拒绝记录分开保留。
