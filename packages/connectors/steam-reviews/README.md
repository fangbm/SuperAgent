# Steam Reviews Source Plugin

导出 SteamReviewsConnector、steamReviewsConfigSchema 和 normalizeSteamReview。使用 Node 24 fetch 调用官方 GetAppReviews，只依赖 plugin-sdk；实现现有 SourcePluginV1。

配置样例为 examples/config.json。独立运行、publisherKeySecret、分页/回扫限制及 checkpoint 说明见 [M4 使用文档](../../../docs/M4-CONNECTORS.md)。默认 reviewScope=negative，保留差评及已追踪差评的后续修订；reviewScope=all 保留所有公开评价及精确原生快照变化。两种模式均不按原文合并不同玩家评价。更换采集范围需使用新 Source ID，不能复用已有 checkpoint。

目标游戏的全评价归档配置为 [examples/idle-abyss-princesses.json](examples/idle-abyss-princesses.json)。all 模式每轮完整分页回扫，以观察不改变评价更新时间的票数、评论数和开发者回复变化；每轮分页预算耗尽后从持久游标继续。未变化的原生快照不会增加事件。匿名响应可缓存十分钟，示例采用十分钟轮询；当前模式的 checkpoint 随评价数增长。仅导入原文到现有 Host、不运行 admission/分析时加 `--archive-only`，详见 [实际归档记录](../../../docs/M4-STEAM-ARCHIVE.md)。

当前快照不能提供已删除评价或所有中间修订，coverage 为 partial。真实公开 API 冒烟与目标 App 权限验收分开记录在 [验收记录](../../../docs/M4-ACCEPTANCE.md)。
