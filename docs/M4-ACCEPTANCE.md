# M4 验收记录

2026-11-02，基线 fc3da33。Node 24.11.1 / pnpm 11.25.0 / TypeScript 5.9.3；参考套件使用工作区工具 uv 0.13.6 / Python 3.13.18。原有 109 个 Node 测试已通过；本分支新增 8 项 M4 测试。

完整 pnpm install --frozen-lockfile 与 pnpm check 验证：build/typecheck/test/boundaries/freeze 均通过，Node 测试 117/117，Python 参考套件 6/6；45 个冻结文件未变。平台传输是合成 fixture/注入客户端，持久化使用真实文件 SQLite 和现有 Source Host，不能称为真实权限验证。

Steam 真实公开 API：AppID 570，GetAppReviews HTTP 200，ID 为字符串。独立 CLI 有限读取最多一页 20 条，5 条差评进入 M1 Host，5 次 Admission 完成，checkpoint 保留未完成分页，coverage=partial；未执行 M3 或修改外部评价。AppID 480 的 response={} 不视为成功空页；旧 appreviews 本次未解析为 JSON，不据此推断全球状态。目标 App 与 publisher key 尚未验证。

已知限制：公开当前快照不能恢复删除和所有中间修订；回扫窗口外才暴露数据可能遗漏；评价 checkpoint 随已追踪对象数增长。同来源不支持多活写者，持续网络故障由进程管理器重启。Discussions 远程采集不在本分支交付，另行调查与明确降级。详见 [运行与配置](M4-CONNECTORS.md)。
