# 当前功能与验收状态

更新日期：2026-11-05。代码核对基线：main 的 `e6fbd199b3acb48b86f70acc2ef9533ba209489e`（已合并 #14–#17）。本轮按用户授权依次合并结构化报告、私有附件捕获、跨消息归属与 GitHub 原生文件发布，合并后主线完整检查通过。PR #14 的 QQ 显式反馈/常驻菜单及真实验收修复见 [记录](QQ-MAIN-INTEGRATION-2026-11-05.md)。各轮验收、ADR 与 `docs/reference/v0.9` 保留历史记录或原始设计，不能将其历史措辞当作当前功能清单。

## 已合并范围

- [PR #6](https://github.com/fangbm/SuperAgent/pull/6)：回滚 #4 的整体实现。
- [PR #7](https://github.com/fangbm/SuperAgent/pull/7)：统一正式入口、共享 M1/M3/M5、可信 Registry、插件隔离与恢复、一小时稳定预算恢复、Windows 测试清理修复。
- [PR #8](https://github.com/fangbm/SuperAgent/pull/8)：Steam 全评价、评价评论及公开 Discussions；修正积压编辑/附件 Admission，贯通主题标题的抽取、匹配、证据校验及 QQ/Web 原文展示。
- #9：当前架构/运行说明同步；#10：P0 与统一 Embedding；#11–#13：模块化 Discord Source、私人工单和临时语音房，复用同一 Core/Host/Gateway，不恢复 #4 整体实现。
- #14：QQ 显式反馈/常驻菜单、历史报告分页和实时查询修正；#15：结构化 Bug/建议报告；#16：附件受控捕获、加密存储和授权读取；#17：跨消息附件归属、工作台确认/拒绝、原生图片/普通文件上传与同版本报告刷新。

以上均已合并。PR #5 保留参考，不是运行依赖。Discord 工单/语音房采用 #11–#13 的模块化实现，真实权限与副作用仍未验收；#4 的整体服务/部署实现未恢复。仓库及 workspace 包保持私有，未发布包或部署服务；后续 PR 默认 Draft，合并须遵循用户当次授权。

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

附件子能力默认开启，仍受平台父开关和 GitHub 写入授权控制；全部相关平台关闭时不索取闲置附件密钥，使用时要求固定 SA_ARTIFACT_KEY。普通文件需显式配置上传会话，可运行 pnpm github:session 在 Windows 用 DPAPI 保存；不自动读取浏览器 Cookie，不随合并复制工作树凭据或启动服务。详见 [跨消息附件](CROSS-MESSAGE-ATTACHMENTS.md)。

## 功能与证据边界

| 范围 | 当前实现 | 已证明的范围 / 剩余限制 |
| --- | --- | --- |
| M0 / M1 | 冻结类型/SDK/Schema；Archive-first、原子 checkpoint/outbox、租约队列和持久合批 | 45 个冻结文件检查、真实文件 SQLite、幂等与实际进程崩溃回归；单独 M1 不运行模型 |
| QQ | 官方 Source/C2C、显式群反馈、常驻管理菜单 | 指定群普通消息、批处理/模型及本轮手工/面板/引用/图片、常驻菜单和 310.3 秒被动回复实测；无历史/编辑对账，不推断其他群权限或 60 分钟最大时限 |
| M3 / GitHub | 多意图提取、独立 Bug/建议匹配、领域与检索、私有仓库同步 | 真实模型和私有测试 Issue/统计评论/状态读回已有记录；不等于总体模型准确率；unknown 不盲目重发 |
| 结构化报告 / 附件 | 详细 Bug/建议报告、加密捕获与授权读取、跨消息归属、工作台确认、原生图片/普通文件发布 | QQ 单张 JPEG 捕获、GitHub 合成 PNG/TXT 上传分别实测；跨消息 QQ 与 PDF/ZIP/DMP 为受控测试，未做视觉/OCR、Claude Code 读取或同一张 QQ 图片的整条联调 |
| Discord | 公共 Source/线程发现、隔离私人工单及临时语音房，共用 Gateway | 受控 HTTP/WebSocket、同库 Host 和崩溃恢复回归；真实账号/频道权限及副作用仍未验收 |
| Steam | 官方负评/全评价、独立评价评论、Discussions public/snapshot | 真实有界读取 142 事件与重放、旧 19 条评论的独立录制回放；不承诺全历史、实时延迟或所有表面覆盖 |
| M5 | 固定北京时间 18:00/00:00 窗口、封存修订、QQ/Web 导航/原文/状态、Web 关联纠错 | QQ/GitHub 状态闭环与 Web 显示有分轮真实确认；标题最新修正为受控接口回归；QQ 无移动/拆分/合并纠错入口 |
| P0 | 五秒紧急合批后的独立分析、领域证据确认、持久 incident/generation、专用 QQ P0 投递、Web 归档/开发者动作 | 本地真实 SQLite 与受控模型/平台接口验证；默认关闭，需显式启用分析；真实主动发送权限与实际送达待验收 |
| Embedding | 统一配置独立 provider、受管理增量索引、hybrid 查询、故障词法降级与冷却 | 本机 HTTP 验证索引/查询/版本与文本隔离；真实向量质量、跨语言召回率和长稳待验收 |
| 生命周期 / M6 | Supervisor 短期退避、长期恢复、稳定预算、Host 撤权及故障隔离 | 默认长期间隔 15–18 分钟；健康 60 分钟恢复全部短期预算；小时边界为虚拟时钟测试，非真实一小时在线验收 |

主题标题与正文分别作为原始证据，M1/M3 均可读取，匹配不会只依赖模型摘要；QQ/Web 展示完整归档标题和正文。正文偏移仍以原始正文为准，旧事件、封存报告与锚点不改写。

默认 auditSampleRate=0.02，普通消息中少量审计样本也会在启用 M3 后调用模型；“过滤无关消息”不等于零调用保证。公开 Steam 页面只报告 partial；被动 probe 的 unknown 不等于没有反馈，也不证明已获完整权限。

## 当前验证汇总

2026-11-05 合并 #15–#17 后，在主线执行锁文件安装与完整 `pnpm check`：546 项 Node 测试、6 组参考验证、构建/类型/依赖边界及 45 冻结文件检查全部通过，0 失败/跳过。本机证据为 .artifacts/merge-15-17-install.log 和 merge-15-17-check.log。三个 PR 的最新远端作业均有计费/支出限额导致未启动的注释，不能记为远端 CI 通过；本轮不部署或额外外发。

2026-11-05 PR #14 整合时：锁文件安装、完整 `pnpm check`（501 项 Node、6 组参考验证、构建/类型/边界/45 冻结文件）和 M6 76 项通过。QQ 四项真实验收有独立收件/归档证据；组合版本以本地受控回归验证。501/76 与下表均保留为旧阶段结果，本轮未独立重跑 M6 专项命令。

2026-11-04：合并基线为 355 项 Node / 76 项 M6；本分支验证如下：

| 检查 | 结果及性质 |
| --- | --- |
| pnpm install --frozen-lockfile / pnpm check | 380 项 Node 测试、6 组 Python 参考验证；构建、类型、依赖边界、45 冻结文件检查通过；本分支新增 25 项 P0 / Embedding 回归 |
| pnpm test:m6 | 76 项专项通过；含本地 HTTP、真实 SQLite 和进程恢复，不是线上平台故障注入 |
| 最新 PR #8 CI | [运行记录](https://github.com/fangbm/SuperAgent/actions/runs/41808863931)：最终 feature head 121f1cb，Windows/Ubuntu 均通过 |
| 文档示例 | 根配置与 Steam 示例 check-config 通过；未配置模型环境的 Steam 示例启动会报 APPLICATION_SECRET_MISSING，不是“默认关闭模型” |

380/76、501/76 是历史分支/整合阶段数字；当前主线完整检查为 546 项 Node 与 6 组参考验证。旧记录中的 219、261、276、291、338、355 等数字属于对应历史阶段，不回写成当前数量。类型检查、受控平台测试、真实有界读取、客户端实际送达分别按证据说明，不互相替代。

## 尚未交付或验收

- P0 与统一入口 Embedding 已合入主线，未做真实平台送达或真实向量质量验收。默认关闭，仅设置 SA_EMBED_* 不会自动启用；需显式配置 embeddings。
- 附件跨消息 QQ 场景、PDF/ZIP/DMP 逐类型原生上传及 Claude Code 授权读取尚待真实联调；新附件页面有 HTTP/DOM 回归，本轮浏览器连接不可用，未计真实视觉验收。合成 TXT 的真实上传与单张 QQ JPEG 捕获分别有记录，不拼成完整端到端验收。
- 尚无持续数小时/数天的平台长稳、真实故障注入和高负载验收；有界运行、模拟时钟和 CI 通过不能替代这些结果。
- Discord 实际部署权限、Steam 完整历史及新反馈延迟上界、其他 QQ 群权限仍需按目标验证。新闻/UGC/指南/截图评论保持调查范围。
- 其他设计范围包括生产数据保留/删除治理、多租户公网服务与总体模型/真实 Embedding 质量评估；私人工单隔离已实现，但真实 Discord ACL 仍需平台验收，均不得由本地小样例推断总体完成。

## 历史记录入口

[统一入口验收](UNIFIED-APPLICATION-ACCEPTANCE.md)、[QQ 主链路](QQ-MAINFLOW-ACCEPTANCE.md)、[M3 验收](M3-ACCEPTANCE.md)、[M4 初期验收](M4-ACCEPTANCE.md)、[M5 验收](M5-ACCEPTANCE.md)、[M6 验收](M6-ACCEPTANCE.md)、[跨组件真实验收](E2E-ACCEPTANCE-2026-11-03.md) 与 [Steam 证据](evidence/steam-public-unified-2026-11-04.json) 保留当轮输入、预算、实际效果和限制；本轮文档同步不扩大既有真实平台授权或验收结论。
