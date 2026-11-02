# SuperAgent

跨平台游戏社区反馈系统。已完成 **M0 契约、M1 持久化与 M3 批次分析/领域/GitHub 同步主链路**，基于用户提供的 v0.9 设计包。QQ 官方 Source/开发者 C2C Delivery 已完成真实群 @ 接入与私聊送达验证；M4 新增 Steam Reviews 与 Discord 适配器，真实平台验收范围见下文。Steam Discussions、Web、报告生成与交互仍未交付。

代码由用户授权托管到 GitHub 私有仓库 [fangbm/SuperAgent](https://github.com/fangbm/SuperAgent)，远端为 `origin`，所有 workspace 包均为 `private`。没有发布包或部署服务；后续托管继续保持私有。各里程碑验收记录中的“本地维护”描述保留当时的验收状态。

## 本地验证

环境：Node.js 24（至少 24.4）、pnpm 11.0.8、Python 3.13、uv 0.7.21。依赖版本已锁定。

```powershell
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` 依次执行依赖边界与契约冻结检查、十七个包的构建、类型正反例、Node 契约与集成测试，以及六个 Python/SQLite 参考验证脚本。集成测试包含真实文件数据库、子进程强制终止、10,000 条合成消息及本地 HTTP 协议验证，不调用外部付费接口。Python 验证使用精确依赖版本的隔离环境。

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
| `packages/plugin-host` | 批准收件人、私聊持久操作与 unknown 屏障 |
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

Source 接入由可信 Host 先 `registerSource`，再取得绑定项目/来源的 `sourceHost` 交给插件。平台 SDK 不获得数据库或队列访问权。`worker:m1` 只生成 `feedback.batch.triage` 任务，由显式配置的 `worker:m3` 消费。

Node 24 的 SQLite 内置模块仍会显示实验性 API 提示；当前运行和测试固定在 Node 24 系列。生产迁移前须备份数据库；参考设计时代的非托管数据库不会被自动接管。见 [M1 设计](docs/M1-PERSISTENCE.md) 和 [M1 验收](docs/M1-ACCEPTANCE.md)。

M4 已交付 Steam Reviews 与 Discord Source 插件，接入现有 M1 Host。独立运行、配置 Schema、能力限制见 [M4 文档](docs/M4-CONNECTORS.md)，实际验证见 [M4 验收](docs/M4-ACCEPTANCE.md)。其他连接器在后续独立 PR 中交付。

## 运行 M3

```powershell
pnpm build
pnpm demo:m3
# 在当前进程环境设置 SA_LLM_BASE_URL、SA_LLM_MODEL、SA_LLM_API_KEY 后：
pnpm worker:m3 --database .artifacts/local.sqlite --once
```

`demo:m3` 是确定性适配器示例，没有真实推理；正常 worker 使用配置的模型 HTTP 接口。环境变量名称见 [.env.example](.env.example)，应用不会自动读取 `.env` 文件或保存凭据。

GitHub 同步是可选项：配置 `SA_GITHUB_REPOSITORY`、`SA_GITHUB_TOKEN` 并指定 `--project`。默认不执行外部写入；只有追加 `--github-write` 且目标实际为私有仓库时才允许发送。后续统计写在机器人评论中，开发者 Issue 正文不会被 PATCH。

本轮已用真实 `deepseek-flash` 分析合成 QQ/Discord 反馈，并经用户批准在私有测试仓库创建两个 Issue、读回一条统计评论。平台原始消息接入仍未验收。详见 [M3 设计与运行边界](docs/M3-ANALYSIS.md) 和 [M3 验收记录](docs/M3-ACCEPTANCE.md)。

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

报告设计为北京时间 18:00、00:00 的固定窗口，当前尚未安装报告生成与投递。契约只允许证据确认的 P0 Bug 即时通知；发送结果 `unknown` 保持未知，不能作为普通重试依据。详情见 [API 契约](docs/API-CONTRACTS.md)、[架构边界](docs/ARCHITECTURE.md)、[插件开发](docs/PLUGIN-DEVELOPMENT.md) 和 [M0 验收记录](docs/M0-ACCEPTANCE.md)。
