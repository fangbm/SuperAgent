# SuperAgent

跨平台游戏社区反馈系统。已实现 **M0 契约、M1 持久化、M3 分析/GitHub 主链路和 M5 报告/Web/操作入口**，基于用户提供的 v0.9 设计包。M4 提供 Discord/Steam Source 适配器；Discord 私密工单和临时语音房由 Core 的可信 Host 组合。主程序通过一份 Core 配置注册来源策略、打开一个 SQLite Runtime，并将受限 Host 能力交给插件。

代码由用户授权托管到 GitHub 私有仓库 [fangbm/SuperAgent](https://github.com/fangbm/SuperAgent)，远端为 `origin`，所有 workspace 包均为 `private`。没有发布包或部署服务；后续托管继续保持私有。各里程碑验收记录中的“本地维护”描述保留当时的验收状态。

## 本地验证

环境：Node.js 24（至少 24.4）、pnpm 11.0.8、Python 3.13、uv 0.7.21。依赖版本已锁定。

```powershell
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` 依次执行依赖边界与契约冻结检查、workspace 包构建、类型正反例、Node 契约与集成测试，以及六个 Python/SQLite 参考验证脚本。集成测试包含真实文件数据库、子进程强制终止、10,000 条合成消息及本地 HTTP 协议验证，不调用外部付费接口。Python 验证使用精确依赖版本的隔离环境。

单独运行：

```powershell
pnpm build
pnpm typecheck
pnpm test
pnpm test:reference
```

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
| `packages/connectors/discord` | 指定/自动发现的公开频道与主题采集、共享 Gateway 和有限历史恢复 |
| `packages/discord-community` | 同一 Bot 的私密工单、临时语音房与平台交互；只经 Host 保存状态 |
| `packages/connectors/steam-reviews` | 评价分页、差评追踪或全评价原文/元数据归档 |
| `packages/connectors/steam-discussions` | 默认 unavailable 与显式本地快照降级 |
| `packages/plugin-host` | 批准收件人、私聊持久操作、社区生命周期状态与控制器租约 |
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

Core 配置精确声明来源绑定和处理策略；未列出的来源不被改写。Core 打开唯一 M1 Runtime，插件只收到按来源绑定的 Host 能力，不取得数据库、队列或策略写入权。主程序的公开来源可正常进入 M1 admission；M3 模型分析仍默认关闭，只有 Core 配置 `analysis.enabled: true` 且设置 `SA_LLM_BASE_URL`、`SA_LLM_MODEL` 才会在同一进程启用。独立 `worker:m1` / `worker:m3` 入口仍可用于兼容的分离式运行。

```powershell
pnpm start --config community/idle-abyss-princesses/core-config.json --check-config
pnpm start --config community/idle-abyss-princesses/core-config.json --once
pnpm start --config community/idle-abyss-princesses/core-config.json --setup
# 可选：覆盖配置中的 database 路径
pnpm start --config community/idle-abyss-princesses/core-config.json --database .artifacts/local.sqlite
```

`--once` 是一次有限同步和 Core tick，不代表全历史完成；`--setup` 只执行 Discord 社区设置。Core 配置可选启用 `web.enabled`，M5 会借用同一个 Runtime。

Node 24 的 SQLite 内置模块仍会显示实验性 API 提示；当前运行和测试固定在 Node 24 系列。生产迁移前须备份数据库；参考设计时代的非托管数据库不会被自动接管。见 [M1 设计](docs/M1-PERSISTENCE.md) 和 [M1 验收](docs/M1-ACCEPTANCE.md)。

## Core 主程序与 Discord 社区

标准入口为 `pnpm start --config community/idle-abyss-princesses/core-config.json`。该配置组合 Discord 社区插件和 Steam Reviews，共用一个 Core Runtime；公开来源使用 `standard` 策略，私密工单来源使用 `staff/archive_only`。配置默认关闭模型分析，GitHub 外部写入默认关闭，Web 控制台可选。`--setup` 只运行 Discord 社区初始化；当前真实 Bot/朋友电脑尚未激活。行为、入口和验收见 [Discord Bot](docs/DISCORD-BOT.md)，148 条历史记录的安全交接见 [部署说明](docs/DISCORD-BOT-DEPLOYMENT.md)。

## 运行 M3

M4 提供三个独立 Source 插件：Discord Gateway/REST、Steam Reviews，以及 Steam Discussions 的显式本地快照降级。标准 Core 主程序统一组合插件；`pnpm source:m4` 保留为可信 Core 的兼容委托入口。配置、覆盖限制和运行方式见 [M4 连接器](docs/M4-CONNECTORS.md)，真实平台验证范围见 [M4 验收记录](docs/M4-ACCEPTANCE.md)。Discussions 远程采集当前为 unavailable。

Steam AppID5335850 曾用 `reviewScope=all --archive-only` 实际归档129条公开好/差评；另经一次有界网站读取归档19条评价下评论，共148条原始事件，该次归档没有运行分析。原始证据仍保留；主程序配置对新增公开消息采用标准 M1 admission。归档路径、恢复命令和评论/讨论覆盖缺口见 [Steam 归档记录](docs/M4-STEAM-ARCHIVE.md)。

```powershell
pnpm build
pnpm demo:m3
# 独立兼容 worker；主程序也可通过 Core config 在同一 Runtime 启用 M3
pnpm worker:m3 --database .artifacts/local.sqlite --once
```

`demo:m3` 是确定性适配器示例，没有真实推理；正常 worker 使用配置的模型 HTTP 接口。环境变量名称见 [.env.example](.env.example)，应用不会自动读取 `.env` 文件或保存凭据。

主程序内的模型分析要求 Core 配置 `analysis.enabled: true` 并设置 `SA_LLM_BASE_URL`、`SA_LLM_MODEL`；不会自动读取 `.env` 文件。GitHub 写入还要求配置 `SA_GITHUB_REPOSITORY`、`SA_GITHUB_TOKEN` 并在可信 Core 配置显式设定 `githubWrite: true`，目标须验证为私有仓库。默认保持关闭。后续统计写在机器人评论中，开发者 Issue 正文不会被 PATCH。

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
# 独立 M5 兼容入口；也可在 Core config 中启用 web 共用主 Runtime：
pnpm start:m5 --database .artifacts/local.sqlite --project my-game
```

demo 使用独立数据库和合成数据，终端输出本机地址与演示访问密钥。正常启动在 Windows 用 DPAPI 保存随机访问密钥，自己的终端可运行 `pnpm m5:key --show` 查看。控制台提供报告归档、Bug/建议、原文、状态操作和关联纠错。报告按北京时间 18:00、00:00 固定窗口生成，旧修订不变；QQ 与 GitHub 写入须分别显式启用。见 [M5 运行说明](docs/M5-REPORTS-AND-ACTIONS.md) 与 [M5 验收](docs/M5-ACCEPTANCE.md)。

M5 基础范围已完成验收：QQ 导航按轮次完成有限真实验收，GitHub 与 QQ 状态按钮完成真实关闭/重新打开与读回，Web 在 Markdown 修复后获得用户人工确认。后续支持成功后回发同一状态卡，并在平台两分钟窗口内撤回旧交互消息；半日报始终保留。状态卡刷新和两次撤回已获客户端确认，扩展到其他交互的覆盖范围见验收记录。测试监听不是常驻服务，自动浏览器视觉与其他未覆盖项仍单列。

M5 不安装模型 worker；pending 任务仍须由配置后的 M3 消费。P0 即时通知调度尚未实现；发送结果 `unknown` 保持未知，不能作为普通重试依据。详情见 [API 契约](docs/API-CONTRACTS.md)、[架构边界](docs/ARCHITECTURE.md)、[插件开发](docs/PLUGIN-DEVELOPMENT.md) 和 [M0 验收记录](docs/M0-ACCEPTANCE.md)。

2026-11-03 的 [QQ 主链路实测](docs/QQ-MAINFLOW-ACCEPTANCE.md) 已覆盖真实用户群普通消息、120 秒自动合批和真实模型，以及验收群三条明确反馈与 60 秒静默合批。修订独立反馈证据及建议匹配字段说明后，保存的真实 QQ 样例已通过真实模型复测：Bug 独立反馈数 2、建议有效反馈数 1，建议关联原条目，无重复或误触发人工复核。旧复核副本保留，真实群与验收群配置分开保存，临时监听均已关闭。

## M6 故障与安全检查

运行 `pnpm test:m6` 可构建并执行 73 项故障专项；M6 新增 17 项测试，完整入口 `pnpm check` 在后续 QQ 主链路修订后总计 219 项。已修复网关积压无上限、投递绑定复核、GitHub 恢复范围隔离和密钥轮换后的 Web 会话撤销。生产及开发依赖在本次审计中均无已知漏洞。

本地验收覆盖重连、限流、超时、重复事件、权限丢失与实际进程终止恢复；不代表在真实平台完成故障注入或长期压测。范围、复现命令和证据见 [M6 验收](docs/M6-ACCEPTANCE.md)。
