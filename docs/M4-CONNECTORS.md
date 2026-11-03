# M4 平台采集与运行

三个独立私有包实现现有 SourcePluginV1，只依赖 plugin-sdk 与 Node 24 内置模块。平台插件通过 Host 获取密钥、提交事件和 checkpoint、报告健康；可信运行脚本负责注册来源、打开既有 M1Runtime。没有新增数据库、队列或 Agent Runtime，也不直接调用 M3。

## 运行

在仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm build

# 检查公开 Steam Reviews 接口，不打开数据库
pnpm source:m4 --connector steam-reviews --config packages/connectors/steam-reviews/examples/config.json --probe

# 单次有限分页，持久化到现有 M1 Host
pnpm source:m4 --connector steam-reviews --config packages/connectors/steam-reviews/examples/config.json --database .artifacts/community.sqlite --project demo-game --source steam-reviews-demo --once

# 修改 Discord 示例中的 Guild / Channel / Thread ID，在当前进程设置 DISCORD_BOT_TOKEN
pnpm source:m4 --connector discord --config packages/connectors/discord/examples/config.json --database .artifacts/community.sqlite --project demo-game --source discord-demo

# 明确的 Discussions 降级，仅导入随附的合成快照
pnpm source:m4 --connector steam-discussions --config packages/connectors/steam-discussions/examples/snapshot-config.json --database .artifacts/community.sqlite --project demo-game --source steam-discussions-snapshot --once
```

去掉 --once 持续运行；Ctrl+C 中止网络请求、停止插件，再关闭 M1。单次模式执行有限分页及一次 M1 tick，可能仍有未完成分页/缓冲分段，不能据此声称全历史或 M3 分析完成。持续模式只运行既有 M1 轻量处理，M3 由用户自己的 worker:m3 消费。不会加载 .env；密钥仅从当前进程环境经 Host 授权读取。

加 `--archive-only` 时仍使用同一 M1 Source Host 原子写入事件、投影、Outbox 和 Checkpoint，但不执行 M1 tick/worker，不创建 admission 决定或分析批次。Outbox 保留 pending；以后启动普通 worker 会消费它，历史仅作上下文的策略须在启用前明确。Steam AppID5335850 全评价归档的实际路径、命令和覆盖缺口见 [M4-STEAM-ARCHIVE.md](M4-STEAM-ARCHIVE.md)。

sourceUri 必须与注册来源一致；同一个 source ID 不得更换项目、URI、平台或采集对象集合。更换 Discord Guild/Channel 集合、Steam AppID 或 Discussions 快照路径时建立独立来源。一个来源只运行一个活跃插件实例；Host 的 checkpoint 接口没有多写者比较交换锁，不能启动两个实例争写同一来源。

--probe 不运行采集。Discord 在绑定 Host 前返回 unknown，绑定后探测当前机器人、应用 Intent、角色/覆盖权限和指定频道；--once 会绑定并实际读取历史。Steam Reviews 的 probe 是匿名公开读取，即使配置了 publisherKeySecret，也不代表发行商密钥已验证；密钥仅在 sync/start 由 Host 读取。Discussions 的 probe 只验证本地快照或报告 unavailable。

## 事件与事务

| 平台输入 | 已有事件类型后缀 | 稳定对象身份 | 修订/关系 |
| --- | --- | --- | --- |
| Discord MESSAGE_CREATE / MESSAGE_UPDATE / MESSAGE_DELETE | message.created / updated / deleted.v1 | 消息 ID 字符串 | Gateway session+sequence；保留引用和指定 Thread ID |
| Discord MESSAGE_DELETE_BULK | 每条 message.deleted.v1 | 各被删消息 ID | 同一批 dispatch 原子提交 |
| Discord REST 快照 | message.created / updated.v1 | 消息 ID | 原生快照哈希；保留原始创建/编辑时间 |
| Steam 评价与修订（默认差评；all 模式包含好评） | review.created / updated.v1 | recommendationid 字符串 | 原生更新时间与完整快照哈希；保留 voted_up 和 native 元数据 |
| Discussions 运营方快照 | thread/comment.created / updated / deleted.v1 | 带 kind 前缀的原生 ID | 精确记录哈希、thread/parent 引用；删除必须显式提供 deletedAt |

事件类型均以 com.superagent.feedback. 开头；无新契约类型。原文放在 content.text，平台元数据放在 attributes，permalink 放在 origin。大整数平台 ID 全程保留字符串，禁止经过 JS Number。

同一输入重放返回 Host 原有 refs；新修订使用新源事件 ID，object.externalId 保持稳定。插件不制造 InternalEventId，不合并内容相似的不同玩家对象。Steam 只在同一评价 ID 内比较原文、语言、作者、推荐状态及平台时间的精确值；票数/游玩时长单独变化不生成新玩家反馈，元数据在实际内容修订时保留快照。

上段 Steam 的内容比较适用于默认 negative 模式。显式 `reviewScope=all` 是先归档的模式：保留每个对象的不同原生快照，包括票数、评论数、游玩时间和开发者回复变化；不在连接器中筛除好评。它逐页回扫所有对象，不用旧更新时间截断。元数据变化没有可靠平台变更时间时仍保留原 timestamp_updated；M1 可记为同时间歧义修订，原始历史完整保留，不声称当前投影已自动解决排序。API 返回的 comment_count 不是评论正文，query_summary 是查询聚合，不能当作额外玩家评价。

每页/dispatch/本地快照先构造完整批次，再调用 commitBatch(events, checkpoint)。成功前不改变持久进度。非法输入、来源冲突、数据库故障会拒绝整批，插件保留旧 checkpoint 并报告错误。Gateway 对后续排队事件设失败屏障，不能跨过失败 dispatch 推进 sequence。心跳使用接收序号维持协议；Resume 使用 Host 已提交序号，两者不混用。Discord 心跳 ACK 是服务器对心跳的响应，并非业务事件入库确认。

插件的 GET 网络失败、429、5xx 最多尝试四次，并遵守 Retry-After；权限失败立即停止该次同步。预算耗尽或 Host 提交失败会抛错，持续进程退出非零，由进程管理器重启。恢复继续读取 Host checkpoint，不丢弃失败页，也不另建重试队列。来源健康在既有 sources 表中持久化，M1 metrics 可查看 coverage/reason；没有可验证总量时不编造百分比。

## 覆盖限制

Discord 要求机器人已加入指定 Guild、启用/获批 Message Content Intent，并拥有各指定 Channel/Thread 的 VIEW_CHANNEL 与 READ_MESSAGE_HISTORY；私有 Thread 还检查成员访问。使用固定的官方 REST/Gateway 域名，验证 resume URL 后才发送凭据。权限变化在周期历史同步时重新检查；Gateway 的权限/Intent 致命关闭也会报告 unavailable。

指定 channelIds 和 threadIds 是完整白名单，不自动发现新建、归档或私有线程。论坛父频道本身不能当消息频道，需配置其 Thread ID。历史按 before 向前分页并保存最高边界；最近一页会回扫编辑。无法 Resume 时会记录 gap、补采仍可读取的消息，但离线删除、已不可见内容、较旧消息的编辑和多个中间修订不能恢复。partial 不会自动升级为 full。Gateway UPDATE 可缺少正文；这时不伪造空正文，保留 partialUpdate/native。删除发生时间平台未提供时使用首次接收时间。Gateway 与 REST 是不同观察路径，可能保留同一对象的重复观察；不会跨对象做语义去重。单实例不支持分片协调，官方要求多 shard 的 Bot 会明确拒绝启动。Gateway 待处理 dispatch 上限 512，超过后断开并从提交序号 Resume。

Steam 的实现依据当前英文 [IUserReviewsService 官方文档](https://partner.steamgames.com/doc/webapi/IUserReviewsService?language=english)，使用替代旧 appreviews 的 GetAppReviews，并按 updated 读取所有推荐状态。实现从查询头部反复扫描，跨页保留游标，完整扫到旧水位以下后才推进水位；同秒边界包含在回扫中。默认回扫重叠 600 秒，每轮最多 10 页，未完成页下次继续。首次扫描可能很长；追踪过差评的对象状态会随评价数增长，checkpoint 序列化成本须监控。API 提供当前公开快照，不能重建两次轮询之间所有编辑或删除；不把缺席当删除。回扫不能保证捕捉平台迟于重叠窗口才暴露的数据。英文接口与本地化旧文档可能不同，应以英文当前文档和实际响应为准。

M1 对同时间的歧义修订、迟到事件会保留原始历史并写入 source_reconciliations；M4 不修改该冻结主链路，也不声称这些歧义已自动解决。

Discussions 调查、候选方式和明确降级方案见 [M4-STEAM-DISCUSSIONS-RESEARCH.md](M4-STEAM-DISCUSSIONS-RESEARCH.md)。快照模式的可用性只证明本地文件可读，不证明 Steam 端授权或采集覆盖率。

## 配置及测试入口

配置 Schema 随各包导出并放入 manifest.configSchema，构造器也验证配置。示例放在各包 examples，避免修改冻结的根 config。snapshotPath 相对进程工作目录解析；运营方应通过临时文件写好后原子替换快照，避免读到半写文件。快照最多 10 MiB/10,000 条，超限整批拒绝而非截断；格式参照 tests/fixtures/m4/discussions.json。已存在对象改变必须携带 updatedAt 或 deletedAt；省略对象不会删除历史。title 原文保存在 attributes.title，正文在 content.text。

```powershell
pnpm build
node --test tests/integration/m4-*.test.mjs
pnpm typecheck
pnpm test
pnpm check:boundaries
pnpm check:freeze
pnpm check
```

测试 fixtures 为合成内容。自动化验证、真实公开 API 冒烟及尚缺少的目标平台权限验证分别记录在 [M4-ACCEPTANCE.md](M4-ACCEPTANCE.md)。
