# ADR 0024：跨消息附件归属与原生普通文件上传

2026-11-05，PR #17 后续。保持 A→B→C 三个 Draft PR，不新增主程序、通用 Delivery 或 M0 契约修订。

## 归属是独立关系

附件消息与文字反馈可以分开，其他人插话不应成为硬边界。Domain 增加同库 attachment_links：原 eventId/assetRef → feedback_item_id，跟随原工作项关联找到 Issue，保留来源身份。它不新增 feedback_items/primary 对象，不提高独立反馈数。归属表与追加审计历史使用命名、哈希校验的特性账本；触发器只从已归档事件派生待处理关系，初次安装补齐已有附件，不回写原始事件或 Checkpoint。

同条消息或明确引用回复在目标唯一、当前有效且同项目/来源/会话时自动确认。未引用附件按同发送者、同会话、事件时间前后 5 分钟提出候选，仍需开发者确认。其他人插话不截断检索；缺失发送者、多个反馈目标、跨会话、失效/删除证据均不强行确认。即使确认归属，图片或文件内容也未被自动分析。

每轮最多 50 条关系、每次最多 65 条目标证据；事件时间查询有专用索引。尚未产生反馈的附件继续等待，不以工作项创建时间代替原消息时间。人工拒绝保留，失效关系不能发布；人工关联带原因、actor、版本和追加历史。工作台分页、项目/角色、CSRF、一次性动作令牌和乐观版本检查复用现有 ControlPlane。只读用户不能确认或拒绝。

报告只纳入已确认且仍有效的附件关系，原文字证据与附件消息分别列来源，不伪装为第二条独立反馈。变更通知唤醒原 GitHub outbox，保留人工正文/专用评论保护。报告更新操作加入关联修订，允许 A→B→A 的附件撤销/恢复，且不重传已发布文件。

## 普通文件不是图片 token 接口的重试

官方 CLI 的普通文件功能仍被平台阻塞，参见 [cli/cli #14194](https://github.com/cli/cli/issues/14194)。图片继续使用既有 token 协议。TXT/LOG/JSON、PDF、ZIP、DMP 使用用户显式提供的网页登录会话，走 GitHub 原生 repository-file 策略、字节上传、finalize 三步；不伪装图片、不提交仓库文件、不使用外部证据仓库。

该网页协议并非稳定公共 REST API；实现参考 [协议实现者的记录](https://github.com/drogers0/gh-image/blob/main/documentation/github-image-upload-flow.md)，并用真实私有测试仓库校正了 objects-origin.githubusercontent.com 的精确桶路径。策略须为 private，大小/MIME/ID/finalize 路径一致；存储仅允许两个固定 GitHub 桶或它们在 objects-origin 的固定路径。GitHub 会话/令牌仅发给 github.com，存储网关和下载 CDN 不携带 Cookie/Bearer；签名策略、CSRF 和会话不进入操作账本或报告。上传前私有仓库与权限检查、授权哈希读取、匿名拒绝及 unknown 不重传不变。

Windows 的 pnpm github:session 从用户手工输入加密保存到 CurrentUser DPAPI；应用不读取浏览器 Cookie，不自动登录，不更新全局 gh。也支持显式 sessionEnv；两种来源互斥。缺少会话时保留 waiting_configuration，不上传、不消耗尝试预算，配置后可继续；过期/明确拒绝保留阻塞，未知写入不自动重发。

新增文件类型只做大小、魔数/基本结构校验，原样加密保存、原样发布，不解包、不执行、不声称做过恶意软件扫描。现有每文件 5 MiB 默认限制仍适用。
