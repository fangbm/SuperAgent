# ADR 0022：Archive-first 附件捕获

2026-11-05。PR B 依赖 PR A；不改 M0 SourcePluginV1/Host API、事件 Schema、原始归档或已有迁移。

QQ Source 的私有构造选项获得可信应用注入的 stage 能力（与既有 Operator/Discord 私有 Host 注入相同边界），不导入数据库或领域实现。captureAttachments 与根 artifacts.enabled 都需显式启用。Source 在推进 checkpoint 前持久化加密、限时下载票据，以免归档提交后崩溃永久丢失短链接；后台 Host 只有在 exact project/source URI/external event id/assetRef 已归档且可见后才下载，未归档票据到期即不可用。临时地址从不进入 M0、日志、报告或模型。

同库 artifact_feature_migrations/artifacts-v1 独立哈希账本，不占主迁移编号。每个事件附件有唯一记录和状态/租约/有限重试；URL 票据 AES-256-GCM 加密，存储字节也加密，AAD 绑定用途和 artifact ID。目录与密钥指纹绑定该库，错误密钥拒绝启动；不静默丢弃旧文件。先写加密临时文件再原子 rename，之后确认数据库；过期租约能核验已落盘文件哈希后完成，不再次下载。

仅允许 QQ CDN 精确主机、HTTPS/443/无用户信息，DNS 私网/保留地址拒绝并固定已检查地址供 TLS 使用。不跟随重定向、不携带平台或 GitHub 凭据；限文件数、队列、字节、总空间及超时。图片按 PNG/JPEG/WebP 签名检查；txt/log/json 仅接受 UTF-8 无二进制控制内容，不执行文件，不进行视觉分析。签名/类型检查不等于杀毒或验证图片业务内容。

Web 下载每次复核现有会话与项目授权，下载前后再次授权并复核来源可见性/哈希；只提供 attachment/nosniff/no-store 响应，不公开目录、文件路径、票据或存储密钥。Source 编辑/删除导致旧证据不可见时不能继续读取。

恢复、原子文件/账本确认边界为真实文件 SQLite 和受控故障状态测试；不冒称已经做过真实平台故障注入或本功能专项 SIGKILL。正式入口复用既有主程序管理循环，关闭取消下载，无独立服务或第二套队列管理器。
