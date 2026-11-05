# QQ 与最新主线集成：2026-11-05

按用户明确授权，在现有 PR #14 分支普通 merge main `ce11b252e7c81341a50d282be272461131a0ee8d`，不 rebase、force-push 或改写已有历史。该主线包含 #9–#13 的文档、P0/Embedding 与 Discord Source/Ticket/Voice。M0 冻结契约、已发布迁移和现有真实数据库不修改。

## 冲突处理

- `DurableJobQueue.claim()` 保留主线第五个 `minimumPriority` 数字参数，增加独立的第六个 `fairPriority` 布尔参数；更新 QQ 调用，不将 true/100 混用。普通领取保留持久 3:1 公平配额；优先级 >=100 的紧急候选先执行，不消耗或清空普通任务的配额。所有选择仍受 kinds、最低优先级、共享并发与租约限制。
- AnalysisWorker 保留 urgentOnly 路径，紧急 Worker 使用 >=100 过滤、不启用公平降级；常规 Worker 使用公平调度。优先级不等于已经确认 P0，后续证据评估和授权未改变。
- 统一应用同时保留 P0/Embedding/Discord 装配、重复 Discord Gateway 凭据检查，以及 QQ receive/reject 回调。M5 同时导出 p0Delivery 和 qqHost，复用同一绑定、插件与 Host，不另建投递系统。
- AGENTS.md 保留双方约定。用户本次明确合并授权优先于先前默认保持 Draft 的约定。
- Discord/QQ 的“未来全局迁移”测试样例使用 014，排在已经存在的 013_p0_runtime 后；只修正测试假设，不修改任何生产迁移或账本。

## 验证

- `pnpm install --frozen-lockfile`、完整 `pnpm check`：501 项 Node 测试、6 组参考验证、构建/类型/包边界/45 个冻结文件检查通过。
- `pnpm test:m6`：76 项通过。
- 集成专项 26 项通过：QQ Source-only、Source/Delivery、QQ 菜单与 P0 共用 Host、未授权菜单固定拒绝；紧急候选越过已满公平配额、重启后普通配额保留、最低优先级与 kind 过滤同时生效；实际 AnalysisWorker 的普通/urgentOnly 路径；P0、Embedding 和 Discord 八种模块组合/单 Gateway 回归。
- 新增四项组合回归（含一个嵌套子测试）。真实本机文件 SQLite、受控 HTTP 模型与平台替身、实际子进程崩溃属于本地集成证据。

QQ 四项真实平台证据见 [原生能力验收](QQ-NATIVE-ACCEPTANCE-2026-11-05.md)。这些实测发生在集成前 QQ 修复版本；集成后通过上述受控回归，没有再次打开真实监听、修改菜单、发送 QQ/GitHub 业务消息或调用付费模型。真实 Discord 权限、P0 实际送达、Embedding 总体质量、Linux 及长期压力不由此次本地结果扩大为通过。

## 保留限制

GitHub Actions 最近检查在执行步骤前被账户付款/支出限额阻止，不将此类失败写成测试通过。历史 Windows/Linux CI 通过不替代当前组合版本。QQ 数万条历史反馈的实时快照性能风险仍见 [性能记录](QQ-LIVE-PERFORMANCE.md)：本次不优化该查询，不承诺大负载延迟。

所有新平台模块、模型、P0、Embedding 和外部写入继续由显式配置控制；此合并不等于部署或启用正式服务。
