# QQ 原生能力真实验收：2026-11-05

本轮使用此前验收群的独立 DPAPI 配置及新建 SQLite，未使用真实用户群配置、未复制历史业务库。通过统一应用的 `createApplication` 启动真实 QQ Source/C2C Delivery，模型、GitHub、报告调度和 Web 均关闭。测试脚本仅为验收观测/预算控制，不是第二个正式入口。

用户已明确批准：将空的全局私聊菜单设置并保留为「待办 / 新增 / 报告 / 更多」，监听此前验收群，复用已有群 `bug` 指令面板；仅向绑定开发者被动回复，最多 12 条，至北京时间 13:07 自动停止。不向群发消息、不调用模型、不写 GitHub。结果未知不得重发。

## 当前结果

| 项目 | 已取得证据 | 尚待验证 |
| --- | --- | --- |
| 群消息原生格式 | 已鉴权、Gateway READY，后续心跳正常 | 手机端发送手工/面板/引用/图片样例，核对实际归档与立即批次 |
| 私聊底部常驻菜单 | 真实 GET 备份、批准计划、一次 PUT 成功，GET 读回版本 1 与获批内容一致 | 客户端可见、常驻、命令填入/发送及实际收到回复 |
| 原生 `/` 指令面板 | 真实 GET 确认已有 group/all 面板，包含 command `bug`；本轮未改面板 | 客户端选择后的实际格式和同一解析链路 |
| C2C 被动回复时限 | 测试发送限绑定开发者、必须携带本轮真实 message/event 上下文；硬限 12 次 | 实时及延迟发送的真实结果、客户端收件确认 |

以上不是四项全部通过。用户端操作未完成前，菜单 API 写入成功不等于客户端显示正常；Gateway 登录/心跳不等于已经接收群消息。独立库的 triage 即使入队，也不等于模型分析完成。

## 真实 API 暴露的兼容问题

未设置菜单时，真实 GET 返回 `{"menu":{}}`，没有 `version`；已有校验按带版本、带 items 的模拟响应处理，无法为首次菜单生成计划。现在仅在明确的空菜单响应上使用 `version: null` 表示未分配版本，仍在写入前重新比较版本和完整可写内容。非空的无版本响应、空响应及非法版本仍拒绝。

真实 GET 还会为菜单项自动添加只读 `icon`。工具现在只在读取时移除此平台装饰字段，再执行原有严格可写 Schema 校验；模板仍不允许任意字段或 `icon`，其他未知字段仍拒绝。首次 PUT 已被持久账本记为 succeeded；修复后的重复 apply 返回 already_applied，没有再次 PUT。

上述修复新增四项集成回归，菜单专项 10 项通过；完整 `pnpm check` 通过，418 项 Node 测试、6 组参考验证，冻结契约未修改。

## 官方说明与边界

[GET 菜单](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_menu.get.html) 说明未设置时 menu 为空；[PUT 菜单](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_menu.put.html) 覆盖全局完整配置。首次菜单已获独立批准；后续恢复仍需新的计划和批准。

[指令面板列表](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_panels.get.html) 当前实测查询需携带 scope：省略时返回 HTTP 400/code 30011；带 group/c2c 时成功。只记录真实预检差异，本轮不扩展面板管理产品功能。

[单聊发送文档](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html) 当前概览写被动 60 分钟、每消息最多 4 次，但 msg_id 参数仍写 5 分钟。应记录实际延迟及平台结果，不能将一次即时发送当成整个时限已验收，也不能由局部延迟试验推断所有上下文均可用 60 分钟。

本轮最初的观测脚本包装 Host 后没有同步映射 sync 参数，自检出现 QQ_SOURCE_NOT_STARTED；已停止该实例并修正脚本，首次运行的收集/发送均为 0。替换实例重新登录并通过后续心跳自检。此问题属于验收脚本，不修改生产 Source 或 Supervisor。

原始配置、操作账本、平台响应、观测日志及测试库仅保存在工作树忽略目录 `.artifacts/qq-live-acceptance/`，不提交 OpenID、凭据、访问令牌或原始业务消息。菜单内容和批准前快照仍可由持久账本核对。
