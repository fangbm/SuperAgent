# SuperAgent

Discord 的公开采集、私人工单与临时语音房已按三个 Draft PR 模块化集成，复用统一入口和共享 Gateway；所有新增模块与写入默认关闭。配置、命令、隔离、迁移及尚待真实平台验收的边界见 [Discord 模块化说明](docs/DISCORD-MODULAR-INTEGRATION.md)。

跨平台游戏社区反馈系统。已实现 **M0 契约、M1 持久化、M3 分析/GitHub 主链路和 M5 报告/Web/操作入口**，基于用户提供的 v0.9 设计包。QQ 官方 Source/开发者 C2C Delivery 与 M5 按钮/原文查询的真实验收边界见下文。M4 包含 Discord、Steam Reviews、评价评论和可选的公开 Discussions 采集；平台原文先通过主程序 Host 留档，再由既有管道处理，真实覆盖边界见下文。

代码由用户授权托管到 GitHub 私有仓库 [fangbm/SuperAgent](https://github.com/fangbm/SuperAgent)，远端为 `origin`，所有 workspace 包均为 `private`。没有发布包或部署服务；后续托管继续保持私有。各里程碑验收记录中的“本地维护”描述保留当时的验收状态。

当前功能、配置默认值、合并状态和验证范围统一见 [项目状态](docs/PROJECT-STATUS.md)。原始设计包与历史验收记录按各自日期阅读，不能代替当前运行说明。

## 本地验证

环境：Node.js 24（至少 24.4）、pnpm 11.0.8、Python 3.13、uv 0.7.21。依赖版本已锁定。

```powershell
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` 依次执行依赖边界与契约冻结检查、所有 workspace 包的构建、类型正反例、Node 契约与集成测试，以及六个 Python/SQLite 参考验证脚本。集成测试包含真实文件数据库、子进程强制终止、10,000 条合成消息及本地 HTTP 协议验证，不调用外部付费接口。Python 验证使用精确依赖版本的隔离环境。

单独运行：

```powershell
pnpm build
pnpm typecheck
pnpm test
pnpm test:reference
```

## 正式运行

```powershell
pnpm start --config config/superagent.json
```

统一入口负责 M1、M3、M5、Web、Source 与 Delivery 的组装和生命周期；无需另开 Worker。配置内启用的 QQ、Discord、Steam Reviews、Steam review comments 和 Steam Discussions 自动加载、探测、运行和停止。默认关闭所有平台实例、模型调用、GitHub 与 QQ 写入；启用模型必须同时显式授权外部调用。仅设置环境变量不会启用服务。Steam 专用示例为 `examples/steam-public/superagent.json`，运行及 partial 覆盖说明见 [Steam 运行说明](docs/STEAM-PUBLIC-FEEDBACK.md)。

连接文件位于 `config/plugins/`，凭据仅引用环境变量或现有 DPAPI 文件。既有 M0 默认策略与 45 个冻结文件保持原样。本分支新增默认关闭的 [P0 即时告警与 Embedding](docs/P0-AND-EMBEDDING.md)，均需显式授权。完整配置、运行顺序和证据边界见 [统一主程序](docs/UNIFIED-APPLICATION.md) 与 [验收](docs/UNIFIED-APPLICATION-ACCEPTANCE.md)。下方分里程碑命令保留为开发和调试工具，不是整套系统运行的必要步骤。

## 工程结构

| 目录 | 用途 |
| --- | --- |
| `packages/contracts` | 无业务依赖的公共类型、13 份 JSON Schema、22 份正反例 |
| `packages/plugin-sdk` | Source/Delivery 插件类型入口，只导出类型 |
| `packages/contract-validation` | Host 使用的 JSON Schema 2020-12 校验器 |
| `packages/persistence` | WAL SQLite、迁移账本、校验和及同步事务 |
| `packages/ingress` | 绑定来源、原子入库/游标/outbox、当前投影和 Source Host |
| `packages/job-queue` | 分逻辑队列、租约令牌、重试预算、恢复与取消 |
| `packages/feedback-buffer` | 可逆规则筛选、持久分段、合批、上下文和超时恢复 |
| `packages/agent-core` | M1 轻量 admission worker 与持久调度扫描 |
| `packages/agent-workers` | 有界批次抽取、候选检索、证据匹配与分析运行轨迹 |
| `packages/domain` | Bug/建议、证据校验、原子提案提交、重分析与人工纠错 |
| `packages/memory` | 分项目/种类 FTS5/BM25，以及可选的版本化向量检索 |
| `packages/llm` | 兼容 Chat/Embedding HTTP provider、JSON Schema 与超时限制 |
| `packages/issue-tracker` | 私有 GitHub 校验、外部操作记录、对账及机器人统计评论 |
| `packages/connectors/qq-official` | 官方 WebSocket/签名回调 Source 与独立开发者私聊 Delivery |
| `packages/connectors/discord` | 指定频道/线程 Gateway 采集与有限历史恢复 |
| `packages/connectors/steam-reviews` | 负评/全评价分页与修订、独立评价评论 Source |
| `packages/connectors/steam-discussions` | 默认 unavailable，可选 public 远端页面或 snapshot 本地文件 |
| `packages/plugin-host` | 批准收件人、私聊持久操作与 unknown 屏障 |
| `packages/reporting` | 固定窗口、封存修订、Steam 成员与补报调度 |
| `packages/control-plane` | 项目/角色权限、QQ 查询、状态操作、关联纠错与审计 |
| `packages/web-console` | 本机 Web 工作台及 HTTP 入口 |
| `config` | 报告、批处理和通知默认配置 |
| `tests` | 编译期反例、运行时契约与依赖边界验证 |
| `docs/reference/v0.9` | 导入的原始设计和参考 SQL，不是生产迁移执行器 |
| `contracts.freeze.json` | M0 冻结文件清单及 SHA-256 |

## 运行 M1 本地链路

```powershell
pnpm build
pnpm demo:m1
pnpm worker:m1 --database .artifacts/local.sqlite --once
pnpm worker:m1 --database .artifacts/local.sqlite
```

demo 使用新建数据库和合成消息，演示提交、幂等重放、关闭/重新打开，以及注入时钟推进后的 batch 恢复；不会访问平台。worker 只处理已有的 outbox/admission 和超时分段；无消息来源时保持空闲，Ctrl+C 关闭连接。示例数据库放在 Git 忽略的 `.artifacts` 中。

Source 接入由可信 Host 先 `registerSource`，再取得绑定项目/来源的 `sourceHost` 交给插件。平台 SDK 不获得数据库或队列访问权。`worker:m1` 只生成 `feedback.batch.triage` 任务；正式入口在启用模型后由受管理的 M3 消费，独立调试才使用 `worker:m3`。

Node 24 的 SQLite 内置模块仍会显示实验性 API 提示；当前运行和测试固定在 Node 24 系列。生产迁移前须备份数据库；参考设计时代的非托管数据库不会被自动接管。见 [M1 设计](docs/M1-PERSISTENCE.md) 和 [M1 验收](docs/M1-ACCEPTANCE.md)。

## 运行 M3

M4 的三个连接器包提供四个独立 Source 实现：Discord Gateway/REST、Steam Reviews、同包内的评价评论插件和 Steam Discussions。Reviews 默认负评，可显式开启 all；Discussions 默认 unavailable，可选匿名公开页面或本地快照。配置、覆盖限制和主程序运行方式见 [M4 连接器](docs/M4-CONNECTORS.md)，初期验收见 [M4 验收记录](docs/M4-ACCEPTANCE.md)，本轮真实 Steam 读取与重放结果见 [Steam 运行说明](docs/STEAM-PUBLIC-FEEDBACK.md)。公开站点接口不保证全历史；所有插件仅提交原始材料，不直接调用 M3 Worker。

```powershell
pnpm build
pnpm demo:m3
# 在当前进程环境设置 SA_LLM_BASE_URL、SA_LLM_MODEL、SA_LLM_API_KEY 后：
pnpm worker:m3 --database .artifacts/local.sqlite --once
```

`demo:m3` 是确定性适配器示例，没有真实推理；正常 worker 使用配置的模型 HTTP 接口。环境变量名称见 [.env.example](.env.example)，应用不会自动读取 `.env` 文件或保存凭据。

GitHub 同步是可选项：配置 `SA_GITHUB_REPOSITORY`、`SA_GITHUB_TOKEN` 并指定 `--project`。默认不执行外部写入；只有追加 `--github-write` 且目标实际为私有仓库时才允许发送。后续统计写在机器人评论中，开发者 Issue 正文不会被 PATCH。

该轮已用真实 `deepseek-flash` 分析合成 QQ/Discord 反馈，并经用户批准在私有测试仓库创建两个 Issue、读回一条统计评论。该轮模型输入仍为合成消息；后续真实 QQ 普通群消息和自动批处理见 [主链路验收](docs/QQ-MAINFLOW-ACCEPTANCE.md)。详见 [M3 设计与运行边界](docs/M3-ANALYSIS.md) 和 [M3 验收记录](docs/M3-ACCEPTANCE.md)。

当前源文件以 `packages/contracts` 为权威。原压缩包的旧校验清单不作为工程输入；原包身份记录在 `docs/reference/SOURCE.json`。

## 使用边界

QQ 的环境配置、回调启动、权限探针和一次性私聊测试见 [QQ 接入](docs/QQ-OFFICIAL.md)；当前真实联调状态见 [QQ 验收](docs/QQ-ACCEPTANCE.md)。

```typescript
import type { SourcePluginV1 } from '@superagent/plugin-sdk';
import { validateContract } from '@superagent/contract-validation';

const result = validateContract('normalized-event-v1', unknownPayload);
if (!result.valid) {
  // 记录字段路径和规则名，不记录玩家原文或凭据。
  console.error(result.errors);
}
```

JSON 校验只能证明结构符合约定。Host 仍须验证项目/来源归属、证据存在、内部 ID 的来源、权限、报告成员一致性和状态变更合法性。类型品牌和非空字符串都不能代替数据库验证。

## 运行 M5

```powershell
pnpm build
pnpm demo:m5
# 生成 QQ Markdown 示例与离线预览，不发送消息：
pnpm preview:qq
# 已有数据库；仅准备报告，不开启外部发送：
pnpm start:m5 --database .artifacts/local.sqlite --project my-game
```

demo 使用独立数据库和合成数据，终端输出本机地址与演示访问密钥。正常启动在 Windows 用 DPAPI 保存随机访问密钥，自己的终端可运行 `pnpm m5:key --show` 查看。控制台提供报告归档、Bug/建议、原文、状态操作和关联纠错。报告按北京时间 18:00、00:00 固定窗口生成，旧修订不变；QQ 与 GitHub 写入须分别显式启用。见 [M5 运行说明](docs/M5-REPORTS-AND-ACTIONS.md) 与 [M5 验收](docs/M5-ACCEPTANCE.md)。

M5 基础范围已完成验收：QQ 导航按轮次完成有限真实验收，GitHub 与 QQ 状态按钮完成真实关闭/重新打开与读回，Web 在 Markdown 修复后获得用户人工确认。后续支持成功后回发同一状态卡，并在平台两分钟窗口内撤回旧交互消息；半日报始终保留。状态卡刷新和两次撤回已获客户端确认，扩展到其他交互的覆盖范围见验收记录。测试监听不是常驻服务，自动浏览器视觉与其他未覆盖项仍单列。

独立 `start:m5` 不安装模型 worker；正式统一入口可同时运行已配置的 M3、M5、P0 与 Embedding。P0 只对证据确认的严重 Bug 告警，仍计入半日报；发送结果 `unknown` 保持未知，不能作为普通重试依据。详情见 [API 契约](docs/API-CONTRACTS.md)、[架构边界](docs/ARCHITECTURE.md)、[插件开发](docs/PLUGIN-DEVELOPMENT.md) 和 [M0 验收记录](docs/M0-ACCEPTANCE.md)。

2026-11-03 的 [QQ 主链路实测](docs/QQ-MAINFLOW-ACCEPTANCE.md) 已覆盖真实用户群普通消息、120 秒自动合批和真实模型，以及验收群三条明确反馈与 60 秒静默合批。修订独立反馈证据及建议匹配字段说明后，保存的真实 QQ 样例已通过真实模型复测：Bug 独立反馈数 2、建议有效反馈数 1，建议关联原条目，无重复或误触发人工复核。旧复核副本保留，真实群与验收群配置分开保存，临时监听均已关闭。

## M6 故障与安全检查

2026-11-04 的 main 基线验证：完整 `pnpm check` 为 355 项 Node 测试与 6 组参考验证，`pnpm test:m6` 为 76 项专项测试，均通过。数字随代码变动，当前汇总见 [项目状态](docs/PROJECT-STATUS.md)。M6 最初新增 17 项测试的历史结果保留在原验收记录中。已修复网关积压无上限、投递绑定复核、GitHub 恢复范围隔离和密钥轮换后的 Web 会话撤销；历史依赖审计结论不代表持续有效的漏洞状态。

本地验收覆盖重连、限流、超时、重复事件、权限丢失与实际进程终止恢复；不代表在真实平台完成故障注入或长期压测。范围、复现命令和证据见 [M6 验收](docs/M6-ACCEPTANCE.md)。

QQ 群显式 `/bug`、`/suggest` 与私聊实时待办/新增、原生菜单的配置、权限和受控部署见 [QQ 反馈与菜单](docs/QQ-FEEDBACK-MENU.md)。新功能默认关闭；应用启动不修改线上菜单，真实 QQ 验收仍需独立授权。

结构化 Issue 报告及附件系列已按用户授权，经 PR #15 → #16 → #17 依次合入 main。主线支持分开发送的截图/文件归属、工作台“附件关联”和 GitHub 原生普通文件发布；附件子能力默认跟随已配置的平台开关，文件上传会话可通过 `pnpm github:session` 在本机加密配置。合并不代表启动真实服务或完成全部平台验收；规则、真实验证与未验收边界见 [跨消息附件说明](docs/CROSS-MESSAGE-ATTACHMENTS.md)。
