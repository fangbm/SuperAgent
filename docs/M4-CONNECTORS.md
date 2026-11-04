# M4 平台采集与运行

三个独立私有 connector 包实现现有 SourcePluginV1。平台插件只通过应用注入的 Source Host 获取获准密钥、提交事件/checkpoint 和报告健康。正式应用入口由可信 `scripts/source-registry.mjs` 注册内置 Source，Supervisor 管理插件和 Host 生命周期；统一应用负责打开并共享既有 M1Runtime、M3 和 M5 服务。平台 JSON 不能指定可执行模块或业务处理策略。

## 运行

正式运行使用统一应用配置。Steam public config 显式启用三项 Steam Source（all reviews、review comments、public Discussions）及 M3 模型分析；GitHub、Delivery、报告和 Web 关闭。先在进程环境提供所选 provider 的 SA_LLM_BASE_URL、SA_LLM_MODEL、SA_LLM_API_KEY；无需密钥的 provider 可在本地副本删除 apiKeyEnv。只采集时，在本地副本中将 analysis 替换为 `{"enabled":false,"allowExternalCalls":false}`。

```powershell
pnpm install --frozen-lockfile
pnpm build

# 静态配置/Manifest/权限检查；不访问 Steam
pnpm start --config examples/steam-public/superagent.json --check-config

# 已配置上述模型环境变量后，在限定时间内启动来源和 M3
pnpm start --config examples/steam-public/superagent.json --run-for-ms 60000
```

正式入口为 `pnpm start --config config/superagent.json`。Steam-only 配置使用同一应用组合，数据库为 `.artifacts/steam-public/state.sqlite`。`--check-config` 不执行探测或采集；`--run-for-ms` 限定进程运行时长，插件在启动后自行开始受监督轮询，时间到后统一停止。它不保证完成全历史。统一应用共享 M1、M3、M5 的既有服务，不启动并行 Worker；一个 source ID 同时只能有一个进程写入。


sourceUri 必须与注册来源一致；同一个 source ID 不得更换项目、URI、平台或采集对象集合。更换 Discord Guild/Channel 集合、Steam AppID 或 Discussions 快照路径时建立独立来源。一个来源只运行一个活跃插件实例；Host 的 checkpoint 接口没有多写者比较交换锁，不能启动两个实例争写同一来源。

应用启动时 Supervisor 调用 probe 并按配置周期复核健康，但 probe 不一定发出网络请求。官方 Steam Reviews 使用主动读取；统一入口中的评价评论和 public Discussions 使用被动 probe，未验证时返回 unknown，真实能力由绑定 Host 后的 sync 更新。独立诊断模式下，评论 probe 会先发现带评论的评价，再读取评论端点；没有候选时保持 unknown，Discussions probe 则读取公开论坛初始化信息。snapshot 只验证本地文件。可用的站点原生来源仍报告 partial，不承诺完整历史或平台保证；恢复前还会遵守已持久化的冷却期限。见 [插件开发约定](PLUGIN-DEVELOPMENT.md)。

## 事件与事务

| 平台输入 | 已有事件类型后缀 | 稳定对象身份 | 修订/关系 |
| --- | --- | --- | --- |
| Discord MESSAGE_CREATE / MESSAGE_UPDATE / MESSAGE_DELETE | message.created / updated / deleted.v1 | 消息 ID 字符串 | Gateway session+sequence；保留引用和指定 Thread ID |
| Discord MESSAGE_DELETE_BULK | 每条 message.deleted.v1 | 各被删消息 ID | 同一批 dispatch 原子提交 |
| Discord REST 快照 | message.created / updated.v1 | 消息 ID | 原生快照哈希；保留原始创建/编辑时间 |
| Steam Reviews（负评或配置的 all 范围） | review.created / updated.v1 | recommendationid 字符串 | 官方 GetAppReviews 当前快照；保留 voted_up 和 native 元数据 |
| Steam review comments | comment.created / updated.v1 | `comment:{recommendationid}:{commentid}` | 独立来源，保留 review parent 链接；使用匿名评论页面 |
| Discussions public pages 或运营方快照 | thread/comment.created / updated / deleted.v1 | 带 kind 前缀的原生 ID | public 模式保留 thread/parent；快照删除须显式提供 deletedAt |

事件类型均以 com.superagent.feedback. 开头；无新契约类型。原文放在 content.text，平台元数据放在 attributes，permalink 放在 origin。大整数平台 ID 全程保留字符串，禁止经过 JS Number。

同一输入重放返回 Host 原有 refs；新修订使用新源事件 ID，object.externalId 保持稳定。插件不制造 InternalEventId，不合并内容相似的不同玩家对象。默认负评模式按原文、语言、作者、推荐状态及平台时间比较同一评价，票数/游玩时长单独变化不生成修订；all 模式保存完整 native 元数据变化，即使原生更新时间不变也可生成新观察，checkpoint 保存观察序号和递增观察时间以区分 A→B→A。两种模式的修订都不增加同对象的独立反馈计数。改换 reviewScope 应建立独立来源；旧负评 checkpoint 不会静默转换为 all。

每页/dispatch/本地快照先构造完整批次，再调用 commitBatch(events, checkpoint)。成功前不改变持久进度。非法输入、来源冲突、数据库故障会拒绝整批，插件保留旧 checkpoint 并报告错误。Gateway 对后续排队事件设失败屏障，不能跨过失败 dispatch 推进 sequence。心跳使用接收序号维持协议；Resume 使用 Host 已提交序号，两者不混用。Discord 心跳 ACK 是服务器对心跳的响应，并非业务事件入库确认。

传输层网络失败和 5xx 通常最多四次尝试，同时受每轮实际请求预算限制；官方 Reviews/Discord 的 429 走既有有界退避。新增评价评论和 public Discussions 的 429 会立即结束当前请求、持久保存 Retry-After，后续实例在期限前不发起探测或重试。权限/畸形页面不能当空页推进，个别不可见对象可保留为待重扫缺口。

正式入口由同一 Supervisor 隔离插件故障：短期有限指数退避后，可恢复故障进入默认 15–18 分钟的低频重建；明确永久配置/认证/权限错误停止该实例。公开页面的局部错误还可能由采集器保留 checkpoint 后等待下一轮。单插件错误不会要求整个主程序退出，也不另建调度进程；独立调试命令的退出行为不能代表正式应用。旧实例停止、Host 撤权后，新实例读取已提交 checkpoint，不跳过失败页。退出取消全部待恢复任务，稳定预算规则见 [统一主程序](UNIFIED-APPLICATION.md)。来源健康仍持久保存在 sources 表中，没有可验证总量时不编造覆盖百分比。

## 覆盖限制

Discord 要求机器人已加入指定 Guild、启用/获批 Message Content Intent，并拥有各指定 Channel/Thread 的 VIEW_CHANNEL 与 READ_MESSAGE_HISTORY；私有 Thread 还检查成员访问。使用固定的官方 REST/Gateway 域名，验证 resume URL 后才发送凭据。权限变化在周期历史同步时重新检查；Gateway 的权限/Intent 致命关闭也会报告 unavailable。

指定 channelIds 和 threadIds 是完整白名单，不自动发现新建、归档或私有线程。论坛父频道本身不能当消息频道，需配置其 Thread ID。历史按 before 向前分页并保存最高边界；最近一页会回扫编辑。无法 Resume 时会记录 gap、补采仍可读取的消息，但离线删除、已不可见内容、较旧消息的编辑和多个中间修订不能恢复。partial 不会自动升级为 full。Gateway UPDATE 可缺少正文；这时不伪造空正文，保留 partialUpdate/native。删除发生时间平台未提供时使用首次接收时间。Gateway 与 REST 是不同观察路径，可能保留同一对象的重复观察；不会跨对象做语义去重。单实例不支持分片协调，官方要求多 shard 的 Bot 会明确拒绝启动。Gateway 待处理 dispatch 上限 512，超过后断开并从提交序号 Resume。

Steam Reviews 使用 Valve 官方 [IUserReviewsService](https://partner.steamgames.com/doc/webapi/IUserReviewsService?language=english) 的 GetAppReviews，默认负评范围，也可在 Source config 显式设 `reviewScope: "all"`。它读取公开当前快照，不会重建两次轮询之间所有中间编辑或删除；不把缺席当删除。详细 API 与边界见 [Steam surfaces research](M4-STEAM-SURFACES-RESEARCH.md)。

Steam review comments 是 `steam-reviews` 包内的独立 Source。它用官方评价元数据定位候选评价，再调用未文档化 Steam Community 评论页；有界分页、重试和每日已知对象重扫不能证明完整历史。Discussions `mode: "public"` 同样使用未文档化站点页面路由；public 健康始终 partial，回复请求依赖公开主题页的 `extended_data`。默认 mode 为 unavailable，`mode: "snapshot"` 仍支持运营方准备的 JSON 文件。两种远端页面模式均不得把不可见/缺失对象当作删除。见 [Discussions research](M4-STEAM-DISCUSSIONS-RESEARCH.md)。

应用将每个 Steam Source 注册到现有 M1 Archive/Host，并由 Supervisor 管理 probe、start、stop 和重启。connector 不访问数据库，也不自己创建处理策略、队列或模型调用。全站状态、路径解释和新架构的验收证据见 [Steam public feedback 操作说明](STEAM-PUBLIC-FEEDBACK.md)。

## 配置及测试入口

配置 Schema 随各包导出并放入 manifest.configSchema，构造器也验证配置。示例放在各包 examples，避免修改冻结的根 config。snapshotPath 相对 platform config 文件目录解析；运营方应通过临时文件写好后原子替换快照，避免读到半写文件。快照最多 10 MiB/10,000 条，超限整批拒绝而非截断；格式参照 tests/fixtures/m4/discussions.json。已存在对象改变必须携带 updatedAt 或 deletedAt；省略对象不会删除历史。title 原文保存在 attributes.title，正文在 content.text。

主题标题参与 M1 判断及 M3 抽取/匹配，标题引用与正文引用分别验证，不能拼接跨字段引文。QQ/Web 原文按“标题 / 正文”展示同一已归档事件，保留正文原字节语义与已有证据区间；不改写旧事件或封存报告。

```powershell
pnpm build
node --test tests/integration/m4-*.test.mjs
pnpm typecheck
pnpm test
pnpm check:boundaries
pnpm check:freeze
pnpm check
```

测试 fixtures 为合成内容。当前 Steam connector 文件可从现有 application config 的 trusted Source Registry 装配；运行入口、配置检查和实际验证证据按 [Steam public feedback 操作说明](STEAM-PUBLIC-FEEDBACK.md) 与 [统一入口验收](UNIFIED-APPLICATION-ACCEPTANCE.md) 分别核对。
