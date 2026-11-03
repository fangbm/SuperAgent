# Steam Discussions 能力调查与降级

2026-11-03补充：[实际游戏的平台调查矩阵](M4-STEAM-SURFACES-RESEARCH.md) 已直接匿名读取 AppID5335850 的公开论坛和主题 HTML，并检查其原生 ForumTopic render 请求。公开页面可访问；一条回复端点样本返回明确的隐私错误，不能由此推断全部公开回复不可读取。网站原生路由与 HTML 的稳定性、权限和历史完整性均不等同于官方分页契约，因此本包仍不声称已交付常驻远端采集。另一个 Recommendation render 端点已用于一次19条评价评论观察，归档情况见 [记录](M4-STEAM-ARCHIVE.md)；它不代表 Discussions 主体或公告评论已经采集。

调查日期：2026-11-02。结论：本次未找到经过验证、公开文档化、可可靠枚举指定 App 讨论主题和回复并恢复历史修订的读取接口。远程全量采集保持 unavailable。这是对已核对文档和实测范围的结论，不是对平台所有私有能力作否定判断。

## 证据和边界

官方 [Web API 目录](https://partner.steamgames.com/doc/webapi) 与 [ISteamCommunity](https://partner.steamgames.com/doc/webapi/ISteamCommunity) 未提供本次所需的主题/回复读取分页契约。官方 [Community 说明](https://partner.steamgames.com/doc/features/community) 描述了 Discussions 及论坛可见性/管理，不能替代稳定采集接口。

Steam 的 [订户协议第 4 节](https://store.steampowered.com/subscriber_agreement/) 对自动化交互设有限制；[Web API 使用条款](https://steamcommunity.com/dev/apiterms) 也要求遵守平台规则。工程上不能把公开 HTML 可访问或 robots 未禁止某路径当作采集许可；这里不推断存在未提供的额外授权。

本次读取了公开 robots.txt，其内容没有构成主题/回复分页、修订或删除恢复契约。尝试通过网页检索工具打开 Discussions RSS 候选 URL 未成功，因此 RSS 是否适用仍为 unknown；工具访问失败本身不能证明平台不存在 RSS。没有进一步通过账户 Cookie、私有客户端协议、未文档化 AJAX 接口或验证码绕行实现采集。

| 候选方式 | 本次结论 | 升级所需证据 |
| --- | --- | --- |
| 文档化 Web API | 未验证所需讨论读取接口 | Valve 提供的端点、授权、分页及限流说明 |
| HTML / 未文档化社区接口 | 未实施；稳定性和访问许可不足以承诺覆盖 | 明确访问授权、可维护契约、真实分页与故障测试 |
| RSS | unknown；未验证内容完整性、回复、分页和保留窗口 | 官方发布入口及完整性/保留范围的实测证据 |
| 官方新闻接口 | 对象种类不符，不能替代玩家讨论 | 不能作为本功能的交付证据 |
| 运营方有权提供的本地快照 | 已实现的显式 partial 降级 | 运营方自行确认数据来源与权限；不声称远程覆盖 |

## 已实现降级

SteamDiscussionsConnector 默认不访问网络，probe/reportHealth 报告 unavailable。显式配置 mode=snapshot 与 snapshotPath 后，读取运营方准备的 JSON，校验 AppID、对象 ID、时间、标题/正文和回复关系，通过既有 Source Host 提交。

快照保留稳定对象 ID 与独立修订哈希；父主题和回复关系单独存储。重启从 Host checkpoint 的 revisions 恢复；文件错误和提交失败不会推进。只有明确的 deletedAt 才产生删除事件，缺少对象不会被解释成删除。未知父对象只能保留运营方提供的引用，不能声称已经到 Steam 验证。

该降级只能处理收到的快照，不能自动发现新主题、补足缺失回复、证明平台时间真实性或恢复未导出的中间修改。健康固定为 partial，并附带“本地快照、远端覆盖未知”的原因；不会因文件读取成功升级到 full。

后续若取得受支持的官方/授权读取方式，应在独立变更中补充真实权限、分页边界、更新/删除语义、限流和恢复测试，再扩大能力声明。当前不需要调整冻结 SourcePluginV1。
