# M4 Source 插件

本分支已实现 steam-reviews、discord，只依赖 plugin-sdk 与 Node 24 内置模块；通过可信运行脚本使用现有 M1 Source Host。冻结契约、数据库、队列和 M3 均未修改。每个来源只启动一个实例。

## Steam Reviews

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm source:m4 --connector steam-reviews --config packages/connectors/steam-reviews/examples/config.json --database .artifacts/community.sqlite --project demo --source steam-reviews-demo --once
```

去掉 --once 持续采集。sourceUri 必须匹配注册来源；AppID/身份变化须新建来源。配置 Schema 由包导出并放在 manifest.configSchema；构造器验证配置。publisherKeySecret 可指定当前进程环境中的密钥名，经 Host 授权读取。应用不自动加载 .env。

Steam 的实现依据当前英文 [IUserReviewsService 官方文档](https://partner.steamgames.com/doc/webapi/IUserReviewsService?language=english)，使用替代旧 appreviews 的 GetAppReviews，并按 updated 读取所有推荐状态。实现从查询头部反复扫描，跨页保留游标，完整扫到旧水位以下后才推进水位；同秒边界包含在回扫中。默认回扫重叠 600 秒，每轮最多 10 页，未完成页下次继续。首次扫描可能很长；追踪过差评的对象状态会随评价数增长，checkpoint 序列化成本须监控。API 提供当前公开快照，不能重建两次轮询之间所有编辑或删除；不把缺席当删除。回扫不能保证捕捉平台迟于重叠窗口才暴露的数据。英文接口与本地化旧文档可能不同，应以英文当前文档和实际响应为准。

只提交差评和曾为差评对象的后续状态；推荐状态改变仍保持 recommendationid。原文、语言、作者、时间、permalink 与原生元数据保留。票数/游玩时长变化不冒充新反馈。新修订为新源事件，(source,id) 不冒充 Host 内部 ID。每页事件和 checkpoint 通过现有 commitBatch 原子提交，失败不推进；GET 网络/429/5xx 最多四次尝试并遵守 Retry-After，预算耗尽显式退出供进程管理器重启。

probe 匿名探测公开读取能力；发行商密钥只在 sync/start 读取，不把匿名探测当作密钥验收。coverage=partial，因为删除、中间修订和平台延迟暴露数据无法完全恢复。精确同秒歧义按既有 M1 reconciliation 保留，M4 不另建处理系统。

## Discord

修改 packages/connectors/discord/examples/config.json 的真实 Guild/Channel/Thread ID，在当前进程设置 DISCORD_BOT_TOKEN 后：

```powershell
pnpm source:m4 --connector discord --config packages/connectors/discord/examples/config.json --database .artifacts/community.sqlite --project demo --source discord-demo
```

Discord 要求机器人已加入指定 Guild、启用/获批 Message Content Intent，并拥有各指定 Channel/Thread 的 VIEW_CHANNEL 与 READ_MESSAGE_HISTORY；私有 Thread 还检查成员访问。使用固定的官方 REST/Gateway 域名，验证 resume URL 后才发送凭据。权限变化在周期历史同步时重新检查；Gateway 的权限/Intent 致命关闭也会报告 unavailable。

指定 channelIds 和 threadIds 是完整白名单，不自动发现新建、归档或私有线程。论坛父频道本身不能当消息频道，需配置其 Thread ID。历史按 before 向前分页并保存最高边界；最近一页会回扫编辑。无法 Resume 时会记录 gap、补采仍可读取的消息，但离线删除、已不可见内容、较旧消息的编辑和多个中间修订不能恢复。partial 不会自动升级为 full。Gateway UPDATE 可缺少正文；这时不伪造空正文，保留 partialUpdate/native。删除发生时间平台未提供时使用首次接收时间。Gateway 与 REST 是不同观察路径，可能保留同一对象的重复观察；不会跨对象做语义去重。单实例不支持分片协调，官方要求多 shard 的 Bot 会明确拒绝启动。Gateway 待处理 dispatch 上限 512，超过后断开并从提交序号 Resume。

probe 在 Host 绑定前为 unknown，--once 绑定 Host 并读取有限历史。Gateway create/update/delete/bulk-delete 映射已有 message 事件；保留原文、引用、线程、时间和链接。REST 快照和 Gateway 为独立观察，可能保留同对象的多次观察。Gateway 的收到序号用于心跳，已提交序号才用于 Resume；提交失败的队列屏障禁止跨越失败事件。

## 测试和范围

```powershell
pnpm check
```

fixtures 为合成平台内容；测试使用真实 SQLite/Source Host，分别验证归一化、重放映射、修订历史、来源冲突/非法整批回滚、重启、提交失败、限流和覆盖率。完整结果及真实平台范围见 [M4-ACCEPTANCE.md](M4-ACCEPTANCE.md)。QQ、M3、通知、报告和 Web 不在本次范围。
