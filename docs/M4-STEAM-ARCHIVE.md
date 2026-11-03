# Steam AppID5335850 原文归档

本轮已将 **129 条公开评价（116 好评、13 差评）及19条评价下评论**提交到现有 M1 Source Host，共148条原始事件。评价使用官方公开 API，所有语言、所有购买类型、关闭 off-topic 排除；保留原文、作者 SteamID、Recommendation ID、推荐状态、原生时间、permalink 及 API 提供的原生元数据。评论是另一路有明确范围的匿名网站观察，限制见下文。没有运行 admission、模型分析或 GitHub 同步。

原始证据在 `.artifacts/idle-abyss-princesses/archive.sqlite` 的 `source_events`；这是本游戏项目的本地 M1 归档文件，后续 Discord 来源也应绑定同一项目并使用该文件。不是新建另一套存储服务。Git 只保存代码、配置和不含玩家正文的验收记录，数据库及原始 HTTP 调查缓存保持忽略。

## 运行和恢复

```powershell
pnpm build
pnpm source:m4 --connector steam-reviews --config packages/connectors/steam-reviews/examples/idle-abyss-princesses.json --database .artifacts/idle-abyss-princesses/archive.sqlite --project idle-abyss-princesses --source steam-5335850-reviews-all --once --archive-only
```

去掉 `--once` 才会在前台持续采集；本轮没有安装后台服务。示例十分钟轮询，避免对匿名缓存反复请求。退出后重启同一命令即可恢复 Host checkpoint。更换 AppID 或 reviewScope 需建立新来源。

`reviewScope=all` 保存好评、差评和每个对象的原生快照变化；不同作者的相同文本不合并。每轮完整回扫，以观察旧评价的评论数、票数、开发者回复等变化；有限分页保存进度，下轮继续。大项目需考虑回扫成本和 checkpoint 大小。默认 negative 模式兼容原 M4 差评行为。

`--archive-only` 不消费 Outbox。评价来源129条事件，另一路评价评论来源19条，共148条 pending Outbox，零 admission 决定、零分析任务。M1 metrics 的 `archivedEvents=0` 是下游 archive_only 筛选决定计数，不是原始归档数量；原始条数看 `sourceEventsIngested` / `source_events`。以后开启普通 worker 会消费历史 Outbox；“历史仅用于上下文”的处理策略须先明确，不能把当前未运行分析说成永久排除了历史分析。

## 当前 API 与缺口

官方 [IUserReviewsService/GetAppReviews](https://partner.steamgames.com/doc/webapi/IUserReviewsService?language=english) 提供当前公开评价分页，支持匿名读取；使用 `input_json`。本轮使用 `filter=2`、`languages=["all"]`、`review_type=0`、`purchase_type=1`、`filter_offtopic_activity=false`。旧 appreviews 已弃用，现有连接器直接使用该官方替代接口。

API 的 `voted_up`、`votes_up`、`votes_funny`、`weighted_vote_score`、`comment_count`、退款/购买状态及可用开发者回复随原生评价快照保留。17条评价报告有评论，合计19条；评论正文不在评价 API 内，由下面的网站读取另行保存。首页 query_summary 返回129总评、116好评、13差评；这是接口调查证据和聚合元数据，不伪装成单独玩家反馈事件。聚合响应本身保留在忽略的调查缓存，不属于已提交的129条评价证据。

### 评价下评论：已验证的一次观察

实际公开评价页的 `InitializeCommentThread("Recommendation", ...)` 给出原生 owner/AppID 关联。匿名 GET `https://steamcommunity.com/comment/Recommendation/render/{reviewOwnerSteamId}/5335850/?start={offset}&count=100` 返回 success、start、pagesize、total_count 和 comments_html。本轮有限读取17个已知有评论的评价线程，解析19条稳定 comment ID 和 data-timestamp；每个线程的返回总数与实际解析数及评价报告数一致，未读取登录态或 Cookie。

使用 Python 标准 HTMLParser 提取渲染文本，原生 comment HTML、作者 ID/页面、时间和读取 URL 一并放入事件 attributes.native；不把渲染文本声称为平台未提供的原始 BBCode。通过同一 Source Host 整批提交为 `comment.created.v1`，来源 `steam-5335850-review-comments-observed`，platform=steam-reviews。threadExternalId 保留 review:<RecommendationID>，attributes.parentReviewSourceId / parentRecommendationId 将它与独立评价来源关联；没有复制评价正文为新玩家反馈。

这是 **未文档化网站端点的一次有界观察，不是持续评论连接器的交付**。无删除/私有内容/中间编辑恢复保证，coverage=partial。第二次导入同一快照新增0事件，直接重放回执返回原 Host ID。验收见 [评论证据](evidence/steam-review-comments-2026-11-03.json)。本机操作脚本、捕获结果和渲染响应保留在忽略的 `.artifacts/steam-5335850/`；持续模式的正式代码仅覆盖官方评价 API。

讨论区主题/回复、公告评论、评价下评论、指南/截图/创意工坊等范围及候选接口，见 [平台调查矩阵](M4-STEAM-SURFACES-RESEARCH.md)。页面可浏览不等于存在已验证的全量读取契约；未支持范围如实保留 unavailable/unknown，不按抓取失败或对象缺席制造删除。当前 Discussions 的明确运营方快照降级仍可用。

只能观察公开当前快照，无法恢复已删除/不可见内容或两次采集之间的全部中间修订，coverage 仍为 partial。元数据变化可能不改变平台更新时间，M1 会保留同时间修订及歧义协调记录；不能把源历史的完整保留等同于当前投影自动排序完成。

## 真实验证

第一次实际读取已原子提交129条评价，在空终止页遇到 Steam 省略 reviews 字段的真实差异。已修复为仅在 query_summary.num_reviews 明确为0时接受省略字段；缺字段且无零计数仍拒绝。重启从已提交游标完成扫描，随后全量回扫新增0条，原 Host ID 不变。直接重放一条已归档事件，Host 返回同一内部 ID。

本轮真实验收计数在 [evidence/steam-archive-2026-11-03.json](evidence/steam-archive-2026-11-03.json)。自动化测试使用合成数据和真实文件 SQLite Host，分别验证好/差评、同文不同作者、旧对象元数据变化、分页重启、模式冲突、终止页省略字段、整批回滚、网络/限流、archive-only 子进程重放。它们不证明未实现的讨论/评论 API 权限。
