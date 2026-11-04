# Steam Discussions 能力调查与降级

2026-11-04 更新：对 AppID5335850 的匿名、有界路由验证确认公开 General 论坛、主题和回复可以通过 Steam Community 当前页面读取。回复 render 请求必须带主题页 `InitializeCommentThread` 提供的 `extended_data`；省略时的 `success=false`（“This profile is private”）不能作为公开回复被隐私阻止的证据。public mode 是明确选项；Discussions 默认仍 unavailable，运营方快照仍可选。站点原生接口未文档化，不构成受支持或完整历史 API。路由读取来自统一应用分支建立前的匿名探测；旧分支 Core smoke 只作历史记录，不能证明当前统一应用配置或 Host 的行为。当前正式配置、入口和验证状态见 [Steam public feedback 运行说明](STEAM-PUBLIC-FEEDBACK.md)。

此前的 2026-11-02/03 结论记录当时未验证所需远程分页契约；不应沿用为“公开回复不可读取”或“远程读取未实施”的当前状态。实际游戏的其他 Steam 页面调查见 [平台表面调查矩阵](M4-STEAM-SURFACES-RESEARCH.md)。早期分支观察过19条评价评论；当前统一应用的归档须由新 Host smoke 单独验证，评论与 Discussions 仍是独立来源。

调查日期：2026-11-02；更新验证：2026-11-04。结论：未找到公开文档化的讨论主题/回复采集契约。经 11-04 匿名验证，当前 Steam Community 原生路由可枚举部分公开主题和回复，连接器以明确的 public mode 有界采集观察；远端全量和历史完整性仍不作保证。默认模式仍 unavailable。这是对已核对文档和实测范围的结论，不是对平台所有能力作否定判断。

## 证据和边界

官方 [Web API 目录](https://partner.steamgames.com/doc/webapi) 与 [ISteamCommunity](https://partner.steamgames.com/doc/webapi/ISteamCommunity) 未提供本次所需的主题/回复读取分页契约。官方 [Community 说明](https://partner.steamgames.com/doc/features/community) 描述了 Discussions 及论坛可见性/管理，不能替代稳定采集接口。

Steam 的 [订户协议第 4 节](https://store.steampowered.com/subscriber_agreement/) 对自动化交互设有限制；[Web API 使用条款](https://steamcommunity.com/dev/apiterms) 也要求遵守平台规则。工程上不能把公开 HTML 可访问或 robots 未禁止某路径当作采集许可；这里不推断存在未提供的额外授权。

本次读取了公开 robots.txt，其内容没有构成主题/回复分页、修订或删除恢复契约。尝试通过网页检索工具打开 Discussions RSS 候选 URL 未成功，因此 RSS 是否适用仍为 unknown；工具访问失败本身不能证明平台不存在 RSS。后续验证仅使用页面公开的原生客户端请求，不使用账户 Cookie、登录会话、私有客户端协议或验证码绕行。robots.txt 对路径的状态不等同于许可。

| 候选方式 | 本次结论 | 升级所需证据 |
| --- | --- | --- |
| 文档化 Web API | 未验证所需讨论读取接口 | Valve 提供的端点、授权、分页及限流说明 |
| HTML / 未文档化社区接口 | 当前 public mode 使用匿名 Steam Community 页面及其原生 render 路由；仅报告 partial | Valve 支持的契约或明确授权、稳定分页/修订/删除语义和长期故障证据，才能扩大覆盖声明 |
| RSS | unknown；未验证内容完整性、回复、分页和保留窗口 | 官方发布入口及完整性/保留范围的实测证据 |
| 官方新闻接口 | 对象种类不符，不能替代玩家讨论 | 不能作为本功能的交付证据 |
| 运营方有权提供的本地快照 | 已实现的显式 partial 降级 | 运营方自行确认数据来源与权限；不声称远程覆盖 |

## 运行模式和覆盖范围

public mode 对已配置论坛执行分页，发现主题后读取主题原文和回复。当前 AppID 5335850 的 General 论坛 ID 为 `0`；运行配置使用 `forumIds: ["0"]`。不得把页面解析到的 owner、forum group ID 或 topic ID 写成所有应用通用常量。论坛回复请求必须复用公开主题页给出的 `extended_data` 初始化值。每轮有请求预算，进度经 Source Host checkpoint 保存；请求失败、403、限流、解析错误、`success=false` 均视为失败而不是空页，不能推进失败页游标。同步不是一次完成全量；以健康状态和 checkpoint backlog 观察是否仍有待处理分页。

验证过的路由形状为：论坛页 `GET /app/{appid}/discussions/{forumid}/`；论坛主题索引 `GET /forum/{owner}/{forumType}/render/{feature}/?start={n}&count={n}`；主题页 `GET /app/{appid}/discussions/{forumid}/{topicid}/`；回复页 `GET /comment/ForumTopic/render/{owner}/{feature}/?feature2={topicid}&start={n}&count={n}&oldestfirst=true&extended_data={topic-page-value}`。这些是站点实现观察值，非 Valve 的 Web API 契约。

## 显式快照降级

显式 `mode=snapshot` 与 `snapshotPath` 读取运营方准备的 JSON，校验 AppID、对象 ID、时间、标题/正文和回复关系，通过既有 Source Host 提交。缺少 mode 时仍为 `unavailable`，不访问网络；public mode 需显式设置 `mode: "public"` 与要读取的论坛 ID。

快照保留稳定对象 ID 与独立修订哈希；父主题和回复关系单独存储。重启从 Host checkpoint 的 revisions 恢复；文件错误和提交失败不会推进。只有明确的 deletedAt 才产生删除事件，缺少对象不会被解释成删除。未知父对象只能保留运营方提供的引用，不能声称已经到 Steam 验证。

该降级只能处理收到的快照，不能自动发现新主题、补足缺失回复、证明平台时间真实性或恢复未导出的中间修改。健康固定为 partial，并附带“本地快照、远端覆盖未知”的原因；不会因文件读取成功升级到 full。

后续若取得受支持的官方/授权读取方式，应在独立变更中补充真实权限、分页边界、更新/删除语义、限流和恢复测试，再扩大能力声明。当前不需要调整冻结 SourcePluginV1。
