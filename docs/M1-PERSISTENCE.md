# M1 持久化、Ingress、队列与缓冲

## 使用入口

```typescript
import { M1Runtime } from '@superagent/agent-core';
// policy 使用 config/batching.default.json 中的 feedbackBatching。
const runtime = new M1Runtime('state.sqlite', { policy });
runtime.ingress.registerSource({ projectId: 'game', sourceId: 'qq-1', sourceUri: 'urn:superagent:source:qq-1', platform: 'qq-official' });
const host = runtime.ingress.sourceHost({ projectId: 'game', sourceId: 'qq-1' });
try {
  await Promise.all([sourcePlugin.start(host, abortSignal), runtime.run(abortSignal)]);
} finally {
  await sourcePlugin.stop();
  runtime.close();
}
```

示例中的 sourcePlugin、policy 和 abortSignal 由可信宿主提供；实际宿主还应在任一任务失败时中止其余任务。M1 的 `accept(eventId)` 只创建一次轻量 admission job，没有冒充尚未完整实现的 `AgentCoreV1`（报告/getRun 等留后续阶段）。

## 数据库与迁移

迁移位于 `packages/persistence/migrations`。001→005 与冻结参考文件相同；006 增加项目/来源绑定、对象投影、会话路由、协调记录、队列、Admission、segment/batch 和重处理审计。`schema_migrations` 检查前缀顺序与每个文件的 SHA-256；每份迁移和对应账本记录原子提交。SQL 出错时回滚该版本，已成功的前序迁移保留。

已有业务表却没有迁移账本的数据库会被拒绝，需要单独审计、备份和迁移。不会静默接管原设计包时代的数据库。生产升级前应先离线备份并演练恢复；本轮验证的是新建本地数据库与受控迁移失败回滚，不是既有生产库升级验收。

事务禁止 async 函数/Promise 返回值；业务代码不得在事务回调中启动网络请求或异步任务。嵌套服务调用采用 savepoint。正常关闭和异常构造都会释放连接。

## Ingress 不变量

1. 可信 Host 注册 project/source/URI/platform；Source Host 固定绑定这组身份。密钥只允许显式配置的 key；完整 manifest loader 属于后续插件接入。
2. 全批先 Schema 校验、生成不可变内容快照，再事务写事件、投影、事件会话路由、outbox 与 checkpoint。
3. `(source,id)` 重复且内容相同返回已有内部 ID；重复 ID 内容不同会使整批失败。JSON 对象键顺序不影响比较，refs 顺序与输入一致。
4. 同来源对象的 created/updated/deleted 原始事件全部保留；旧时间不能覆盖较新投影。相同时间无法可靠排序或类型冲突时，记录 `source_reconciliations`，不假装已确定最新版本。该协调队列暂未自动消费。
5. outbox 派发与 admission job 创建同事务；同一次派发的重试不会多建任务。

M1 的 `getEvent` 是 Host 内部原始证据接口，要求 project 匹配；尚未作为 Web/玩家可访问的端点。删除事件更新当前 tombstone，历史内容的保留与合法删除流程仍需后续治理实现。

## 租约和副作用

队列按 admission/full_agent/report/delivery/p0_alert 等逻辑 lane 隔离并发；同优先级/创建时刻按持久插入顺序处理。任务幂等键在项目内唯一，复用键但改变 kind/payload/lane 会失败。

claim 增加 attempt 并产生独立 token；start、heartbeat、complete、fail 均检查 token 和未过期租约。可重试本地错误按 1s/2s…退避（上限 60s），超预算进入 dead_letter。过期租约重领也计入预算。pending/retry_wait 可取消；已经领取的外部任务不能被取消操作假装撤回网络请求。

涉及 GitHub、报告投递或 P0 投递的任务不会自动按普通失败重试：标记 `EXTERNAL_OUTCOME_REQUIRES_RECONCILIATION` 并停在 dead_letter，未来外部操作管理器处理。M1 没有安装任何外部发送 worker，也没有修改 existing external_operations 的恢复协议。

`tick` 只领取 `feedback.admit`，不会消费未安装 handler 的其他任务。完整 Agent 的全局并发初值为 3，但 M1 不领取完整 Agent 任务；report/delivery lane 的存在不代表对应业务服务已实现。

## 筛选、分段与批次

- 仅明确无实质内容的消息归档；抽样采用事件 ID + 策略版本哈希，重放结果稳定。归档消息可通过有 actor/reason/request ID 的 `reprocessArchived` 重新成为候选，原决定保留。
- 策略版本绑定具体数值，不能在重启后用相同 version 悄悄更改参数。每个 segment 保存自己的策略与 quiet/max/urgent 截止时间，重启与新策略不覆盖旧截止时间。
- 新策略重新评估已有候选时保留新决定，但复用原候选归属，不重复构造玩家反馈；显式模型重分析留到 M3。人工归档重处理只允许尚未成为候选的事件。
- 独立对象默认独立 segment；线程和回复链优先。同一分钟的两段独立讨论不会变成同一个 segment/Issue。
- batch 可以包含同来源、同策略的多个 segment；候选不超过 30、上下文不超过 50（默认值）。上下文可跨计算批次引用，但候选事件有唯一约束，只作为一次新候选计数。
- 完整原文保留在 event store。最近一段会话和可解析的回复目标提供上下文；截断数写入 batch 元数据，不能把有限上下文描述为完整历史。提前归档的相关上下文使用持久会话路由索引检索，不扫描全库 JSON。
- quiet 默认 60s，maxWait 120s 且不因持续聊天重置，urgent 5s。以上是本地 **tick 观察到截止时间后创建任务** 的目标，不是模型完成或平台送达时延保证。
- urgent_candidate 只是快速分析线索，M1 不产生 P0 incident 或通知。
- 编辑/删除产生新候选修订和 replay batch，当前投影单独维护；已有 batch 不改写。未来领域层仍须区分同对象修订与独立玩家反馈。

`metrics()` 提供原始事件数、待派发量、Admission/抽检数量、open segment、batch/full-Agent 任务数、pendingAnalysis、队列年龄、来源覆盖率、未协调事件和 flush 原因。模型 token/费用、检测召回率尚无数据，不能伪造为 0 成本或已验证准确率。
