# ADR 0005：封存报告与统一操作者入口

日期：2026-11-03。状态：已采纳。

报告需要稳定窗口、跨端一致的修订和可追溯原文。QQ 回调不能依赖模型执行，也不能直接读取数据库；状态按钮必须与 Web 使用同一权限和状态机。

采用独立 reporting 包，使用北京时间双固定窗口、Host 接收时间及 180 秒宽限期；同事务封存报告、成员、Steam 触发事件与工作项证据，复合哈希校验所有快照内容。修订不覆盖旧版，也不自动额外主动投递。

control-plane 提供项目/角色授权、哈希会话、单次动作令牌、签名分页、持久 QQ 收件箱及回复计划。连接器仅调用注入的 SDK Host 侧回调。reporting/control-plane 不依赖任何具体平台。web-console 提供本机 HTTP 入口；可信启动脚本负责组合依赖和 DPAPI 凭据。

外部状态操作先入 durable outbox。GitHub 状态 PATCH 与机器人统计评论分开存储，确认远端后才落本地状态；QQ 未知发送结果沿用既有 unknown 屏障，只有确定的格式拒绝允许降级。补报任务使用 report 队列，避免占用分析容量。

兼容性：新增迁移 009，不修改迁移 001—008；保留并复制旧 plugin_delivery_requests 数据，将 Host 内部 purpose 枚举增补 interaction。M0 冻结 45 文件、公共 SDK 和默认配置不变，因此不更新 contracts.freeze.json。运行器升级已有库前创建一致性备份。

代价：旧修订证据增加存储；本机登录仍需用户保管访问密钥；QQ Keyboard/Markdown 权限需真实联调；Web 只监听 loopback，公网部署需要独立设计。行为验证覆盖窗口边界、晚到分析、修订、故障回滚、重启补报、原文分页、令牌权限、远端 unknown 对账及 HTTP 安全边界。

2026-11-03 真实联调修正：用户已收到报告，但客户端点击提示无权限，服务端未收到回调。先前使用 permission.type=0 并将 C2C OpenID 当作键盘指定用户 ID；此身份匹配是本次故障的主要疑点。C2C 专用适配器改为 type=2，按钮触达后仍经 Source 的实际 user_openid 白名单和 Host 的项目/操作者/令牌/角色校验。群聊和频道不使用该发送器，转发或冒用的回调仍被拒绝。腾讯官方 SDK 定义见 [keyboard.go](https://github.com/tencent-connect/botgo/blob/master/dto/keyboard/keyboard.go)。不重发已送达报告，改由开发者 `/bugs` 发起查询验证新按钮；总额度沿用原授权。
