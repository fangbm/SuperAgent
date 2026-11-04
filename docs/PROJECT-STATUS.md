# 当前功能与验收状态

更新日期：2026-11-04。代码基线：main 的 `d9937a9de56fbc466470fe428f847e82bc698938`（合并 PR #8，与已复查的 121f1cb 代码树一致）。本页汇总当前状态；各轮验收、ADR 与 `docs/reference/v0.9` 保留当时的记录或原始设计，不能将其历史措辞当作当前功能清单。

## 已合并范围

- [PR #6](https://github.com/fangbm/SuperAgent/pull/6)：回滚 #4 的整体实现。
- [PR #7](https://github.com/fangbm/SuperAgent/pull/7)：统一正式入口、共享 M1/M3/M5、可信 Registry、插件隔离与恢复、一小时稳定预算恢复、Windows 测试清理修复。
- [PR #8](https://github.com/fangbm/SuperAgent/pull/8)：Steam 全评价、评价评论及公开 Discussions；修正积压编辑/附件 Admission，贯通主题标题的抽取、匹配、证据校验及 QQ/Web 原文展示。

以上均已合并，不再是待审 Draft。PR #5 保留参考，不是运行依赖。#4 的 Discord 工单、临时语音房、服务器配置和部署实现未恢复。仓库及 workspace 包保持私有，未发布包或部署服务；后续 PR 默认 Draft，合并须遵循用户当次授权。

## 正式运行与默认值

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm start --config config/superagent.json
```

一份配置、一个正式进程复用同一 M1Runtime、SQLite、队列、Memory、Domain 与 M3/M5 服务，不另开 Worker。独立 worker:m1、worker:m3、source:m4、start:m5 保留为调试入口，不能与正式进程并发操作同库。

| 配置 | 来源 | 模型 | GitHub / Delivery / Web | 报告 |
| --- | --- | --- | --- | --- |
| config/superagent.json | 默认全部关闭 | 关闭 | 全部关闭 | 固定窗口 M5 开启 |
| examples/steam-public/superagent.json | 三项 Steam 来源开启 | M3 与外部调用显式开启 | 全部关闭 | 关闭 |

Steam 示例需在进程环境配置 SA_LLM_BASE_URL、SA_LLM_MODEL、SA_LLM_API_KEY；无密钥 provider 可在本地副本省略 apiKeyEnv。仅采集时将 analysis 替换为 `{"enabled":false,"allowExternalCalls":false}`。应用不自动加载 .env；check-config 不检查环境值存在，也不验证网络能力。详细配置见 [统一主程序](UNIFIED-APPLICATION.md) 与 [Steam 运行说明](STEAM-PUBLIC-FEEDBACK.md)。

## 功能与证据边界

| 范围 | 当前实现 | 已证明的范围 / 剩余限制 |
| --- | --- | --- |
| M0 / M1 | 冻结类型/SDK/Schema；Archive-first、原子 checkpoint/outbox、租约队列和持久合批 | 45 个冻结文件检查、真实文件 SQLite、幂等与实际进程崩溃回归；单独 M1 不运行模型 |
| QQ | 官方 WebSocket/Webhook Source、开发者 C2C Delivery | 指定真实群普通消息、自动合批、真实模型和私聊分轮验收；无历史/编辑对账，不推断其他群权限 |
| M3 / GitHub | 多意图提取、独立 Bug/建议匹配、领域与检索、私有仓库同步 | 真实模型和私有测试 Issue/统计评论/状态读回已有记录；不等于总体模型准确率；unknown 不盲目重发 |
| Discord | 指定频道/线程 Gateway/REST 采集与有限恢复 | 实际连接器类和受控 HTTP/WebSocket 回归；缺少真实部署账号/频道权限验收，不自动发现全部线程 |
| Steam | 官方负评/全评价、独立评价评论、Discussions public/snapshot | 真实有界读取 142 事件与重放、旧 19 条评论的独立录制回放；不承诺全历史、实时延迟或所有表面覆盖 |
| M5 | 固定北京时间 18:00/00:00 窗口、封存修订、QQ/Web 导航/原文/状态、Web 关联纠错 | QQ/GitHub 状态闭环与 Web 显示有分轮真实确认；标题最新修正为受控接口回归；QQ 无移动/拆分/合并纠错入口 |
| 生命周期 / M6 | Supervisor 短期退避、长期恢复、稳定预算、Host 撤权及故障隔离 | 默认长期间隔 15–18 分钟；健康 60 分钟恢复全部短期预算；小时边界为虚拟时钟测试，非真实一小时在线验收 |

主题标题与正文分别作为原始证据，M1/M3 均可读取，匹配不会只依赖模型摘要；QQ/Web 展示完整归档标题和正文。正文偏移仍以原始正文为准，旧事件、封存报告与锚点不改写。

默认 auditSampleRate=0.02，普通消息中少量审计样本也会在启用 M3 后调用模型；“过滤无关消息”不等于零调用保证。公开 Steam 页面只报告 partial；被动 probe 的 unknown 不等于没有反馈，也不证明已获完整权限。

## 当前验证汇总

2026-11-04 的上述 main 代码基线：

| 检查 | 结果及性质 |
| --- | --- |
| pnpm install --frozen-lockfile / pnpm check | 355 项 Node 测试、6 组 Python 参考验证；构建、类型、依赖边界、45 冻结文件检查通过 |
| pnpm test:m6 | 76 项专项通过；含本地 HTTP、真实 SQLite 和进程恢复，不是线上平台故障注入 |
| 最新 PR #8 CI | [运行记录](https://github.com/fangbm/SuperAgent/actions/runs/41808863931)：最终 feature head 121f1cb，Windows/Ubuntu 均通过 |
| 文档示例 | 根配置与 Steam 示例 check-config 通过；未配置模型环境的 Steam 示例启动会报 APPLICATION_SECRET_MISSING，不是“默认关闭模型” |

355/76 是此次基线数字，后续测试变化应更新本表；旧记录中的 219、261、276、291、338 等数字属于对应历史阶段，不回写成当前数量。类型检查、受控平台测试、真实有界读取、客户端实际送达分别按证据说明，不互相替代。

## 尚未交付或验收

- P0 即时调度未实现；notifications.p0Enabled=true 会明确拒绝启动。P0 契约、表和图中规划路径不代表运行能力。
- 统一正式入口目前仅装配 FTS5/BM25，未接入 Embedding provider 配置。底层库与调试 worker:m3 支持 SA_EMBED_*，不能据此声称正式入口已启用向量检索。
- 尚无持续数小时/数天的平台长稳、真实故障注入和高负载验收；有界运行、模拟时钟和 CI 通过不能替代这些结果。
- Discord 实际部署权限、Steam 完整历史及新反馈延迟上界、其他 QQ 群权限仍需按目标验证。新闻/UGC/指南/截图评论保持调查范围。
- P0 之外的其他设计范围包括生产数据保留/删除治理、私有工单独立 ACL、多租户公网服务与总体模型/真实 Embedding 质量评估，均不得由现有小样例推断完成。

## 历史记录入口

[统一入口验收](UNIFIED-APPLICATION-ACCEPTANCE.md)、[QQ 主链路](QQ-MAINFLOW-ACCEPTANCE.md)、[M3 验收](M3-ACCEPTANCE.md)、[M4 初期验收](M4-ACCEPTANCE.md)、[M5 验收](M5-ACCEPTANCE.md)、[M6 验收](M6-ACCEPTANCE.md)、[跨组件真实验收](E2E-ACCEPTANCE-2026-11-03.md) 与 [Steam 证据](evidence/steam-public-unified-2026-11-04.json) 保留当轮输入、预算、实际效果和限制；本轮文档同步不扩大既有真实平台授权或验收结论。
