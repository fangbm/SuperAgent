# QQ 普通群消息与自动批处理真实验收

日期：2026-11-03。状态：**普通群消息接收、自动合批和真实模型调用通过；既有真实 QQ 样例的独立反馈计数及原建议自动关联均已通过真实模型复测。** 本轮所有 QQ 发送与 GitHub 调用均为 0。此前待复核副本保留，不能将同样例重分析通过扩大为所有关联质量、新一轮采集或持续运行验收。

## 目标群识别

用户说明真实用户群已接入并有全部消息权限，但尚不清楚 OpenID。已有 DPAPI 配置实际属于此前验收群，因此先停止错误目标的准备流程，以只读 Gateway 识别一次性标记。

17:27:38，真实用户群中不带 @ 的标记以 `GROUP_MESSAGE_CREATE` 到达，取得的绑定与验收群不同。新绑定单独写入 Git 忽略、Windows 当前用户 DPAPI 加密的 `.artifacts/qq-user-group-20261103.dpapi`，旧 `.artifacts/qq-config.dpapi` 保留。其他群的消息不保存到本轮库，原始 OpenID、凭据和群原文不提交 Git。

## 第一轮：真实用户群的自然消息

使用生产 QQ Source、SDK Host、Ingress、M1 buffer 和 M3 worker；新建独立项目/数据库，使用未修改的默认策略，无测试消息注入或人工 flush。

| 项目 | 真实结果 |
| --- | --- |
| 消息 | 12 条 `GROUP_MESSAGE_CREATE` 自动入库；其中 10 条正文没有 mention 标签 |
| 轻量处理 | admission 12 条完成：candidate 8、needs_context 3、audit_sample 1 |
| 批次 | 一批含 12 条候选消息；17:30:29 按 `max_wait` 自动关闭，真实等待约 120 秒 |
| 分析 | 17:30:33 前完成一次真实 `deepseek-flash` 分析，triage 任务 completed |
| 结果 | `items=[]`，原因 `insufficient_context`；Bug 0、建议 0。人工检查本轮内容为普通讨论，不能据此声称已验证明确反馈的提取 |
| 用量 | 已成功调用 input 3520 / output 87 tokens，仅计已知用量 |
| 停止 | 首批成功后自动关闭；quick_check=ok，外部操作 0 |

随后为准备明确反馈的补验，在真实群另开的一轮接收了 6 条消息；用户要求“换到验收群做”后立即停止，保留未关闭 segment，没有运行模型，不自动补处理此轮。

## 第二轮：验收群的明确反馈样例

按用户要求切回此前验收群，使用旧 DPAPI 配置和另一个独立数据库。用户不 @机器人，人工发送两条相同崩溃反馈、一条自动重连建议；内容是验收样例，经真实 QQ 平台送达，不能记为自然玩家反馈。

三条目标文本均匹配，另有 7 条普通消息同时到达，共 10 条 `GROUP_MESSAGE_CREATE`，正文均无 mention 标签。17:36:59 最后一条入库，17:38:00 按 `quiet_timeout` 自动形成一批，没有人工 flush；17:38:26 完成真实模型分析。一次调用 input 2897 / output 415 tokens，产生一个 Bug 和一条建议，原文均保留，任务完成，无外部投递。

**本轮发现计数问题**：模型将第二条独立崩溃报告标为 corroboration，首轮 Bug 反馈数为 1，建议反馈数为 1。它没有丢掉原文，但未达到“两条独立崩溃反馈计数 2”的预期，因此该项不能记作通过。

## 修订与复测边界

提示词已补充独立候选报告的 primary 规则，默认管线改为 `triage-v2.2`，见 [ADR 0011](ADR/0011-independent-report-primary-evidence.md)。本地新增回归证明重分析能够保留旧修订与源事件，将反馈数从 1 改为 2，并避免重复 Issue 或把上下文计数。

对第二轮真实输入采用只读源库与 SQLite backup 创建副本后重分析，没有重发群消息、改写原库或手工修正 evidence 角色。实际遇到四次 HTTP 503（`service_unavailable_error`）：原重分析任务有限重试三次耗尽；冷却后的最后一次新修订仅允许一次尝试，仍失败。失败用量未知，不计为零或并入已知用量。副本保留失败任务和原提取，真实计数修复复测仍待模型服务恢复。不要自动重放这些失败任务。

18:16 用户要求“再试试”，另从包含历史失败记录的副本创建只读源备份，新建修订 4 的独立分析任务，最多两次任务尝试。18:17:24 与 18:17:39 两次均返回 HTTP 503 / `service_unavailable_error`，任务转 dead_letter 后停止，pending 任务为 0，没有重放此前失败任务。读回确认原始源事件、提取修订、反馈项、关联及 Bug/建议状态和计数均未变；quick_check 与外键检查通过，QQ 发送和 GitHub 调用仍为 0。该轮只增加服务失败证据，不能改记计数修复已通过。机器记录位于同一证据文件的 countCorrectionRetest1816。

18:37 用户再次要求重试，另从修订 4 的完整副本创建备份，新建修订 5，未重放旧失败任务。模型接口恢复，三次真实调用（提取、Bug 匹配、建议匹配）均成功；18:38:01 worker 完成。Bug 仍只有一个，两条独立原文均为 primary，反馈数从 1 变为 **2**。建议的有效反馈数为 **1**，七条闲聊未增加任何反馈数。原始 10 条消息、首轮提取、旧 dead_letter 任务均完整保留，pending 与外部操作为 0。此次证明新提示词在已保存的真实 QQ 样例上的计数修订，不是重新采集或新的定时报送验收。

建议匹配有独立复核项：模型虽返回 same_request，却在 distinguishingDetails 填入了“一致”的解释；现有保守规则因该字段非空而拒绝自动关联，创建待复核的新候选，旧建议在重分析后反馈数为 0 并保留历史。因此当前有效工作项为 Bug 1、建议 1，数据库另有一个空历史建议，不能计为第二份有效建议。没有忽略冲突字段或自动人工合并。临时验收脚本原先严格断言总工作行数为 2，因此在 worker 已成功后报断言失败；独立读回按有效反馈和历史记录分别核实了上述结果，原断言和后续核对均保留。计数修复通过，不等于建议已自动关联通过。机器记录位于 countCorrectionRetest1837。

19:05 用户再次要求重试，先从同一原基线另建副本，三次真实模型调用再次得到 Bug 反馈数 2、建议反馈数 1，但建议又因一致性说明误填 distinguishingDetails 而进入复核。该次证据保存在 countCorrectionRetest1905，不覆盖前一轮结果。

随后澄清建议匹配字段的运行时 Schema 说明及提示词，见 [ADR 0012](ADR/0012-suggestion-match-field-meaning.md)，没有放宽 Host 的冲突、区别或证据检查。从同一基线再建独立副本复测，未共享前一轮成功调用缓存：三次真实调用全部成功，原 Bug 计数 2，原建议计数 1，建议匹配为 same_request 且 conflictingRequirements / distinguishingDetails 均为空。两种工作项各仅一行，建议 ID 与基线相同，reviewRequired=false，无重复建议、空历史建议或 pending 任务。原始 10 条源事件、首轮提取、旧失败任务和基线库均未改写，QQ/GitHub 写入为 0。新增最终结果位于 suggestionMatchRetest；该用户请求内合计 6 次真实调用。之前复核副本没有被手工合并或自动解除标记。

最新完整 `pnpm check` 已通过 **219 项 Node 测试、6 组参考验证与 45 个冻结文件检查**。两项新回归分别验证相同证据的标题改写能正常关联，以及真实区别仍阻止自动关联。先前 217 项及各轮平台结果保留为历史证据。

## 运行与未覆盖项

本轮均为有预算的临时验收监听，已经关闭，不是常驻生产服务。真实用户群和验收群配置分别保留，需显式选择，不能互相静默覆盖。

```powershell
# 终端一：真实用户群，自动接收及 M1 批处理；仅本机 HTTP 监听
pnpm qq:source --database .artifacts/qq-mainflow-live-20261103-r3/state.sqlite --project qq-mainflow-live-20261103 --source qq-mainflow-live-group-01 --kind group --transport websocket --protected-config .artifacts/qq-user-group-20261103.dpapi
# 终端二：通过环境变量配置模型后，消费同一库的分析任务
pnpm worker:m3 --database .artifacts/qq-mainflow-live-20261103-r3/state.sqlite
```

以上命令没有启用 GitHub 写入或 QQ Delivery。Source 与 worker 分工保持不变，单独启动 M1 不执行模型。

运行时 coverage 仍为 partial，原因 `QQ_ALL_MESSAGES_OBSERVED_NO_HISTORY_OR_EDIT_RECONCILIATION`：本轮证明指定群的普通消息可以收到，不证明平台历史/编辑/撤回补齐或所有群授权。停止后来源健康为 unavailable / QQ_SOURCE_STOPPED。未提前生成尚未到期的半日报，未测试本轮数据的定时报送、持续运行、故障恢复或主动通知。

脱敏机器记录见 [qq-mainflow-live-2026-11-03.json](evidence/qq-mainflow-live-2026-11-03.json)。原库、原文和加密配置均保留在 Git 忽略的 `.artifacts`。
