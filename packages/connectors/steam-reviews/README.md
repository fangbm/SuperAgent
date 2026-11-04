# Steam Reviews Source Plugin

导出 SteamReviewsConnector、steamReviewsConfigSchema 和 normalizeSteamReview。使用 Node 24 fetch 调用官方 GetAppReviews，只依赖 plugin-sdk；实现现有 SourcePluginV1。

配置样例为 examples/config.json。独立运行、publisherKeySecret、分页/回扫限制及 checkpoint 说明见 [M4 使用文档](../../../docs/M4-CONNECTORS.md)。读取所有推荐状态，以捕捉差评转好评；仅差评和已追踪差评的后续修订进入 Host，不按原文合并不同玩家评价。

当前快照不能提供已删除评价或所有中间修订，coverage 为 partial。真实公开 API 冒烟与目标 App 权限验收分开记录在 [验收记录](../../../docs/M4-ACCEPTANCE.md)。
