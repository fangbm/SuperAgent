# M4 验收记录

日期：2026-11-02。实现起点为 main 的 fc3da33，随后合入并行更新 5c2dedf，保留其 QQ 实现并重跑完整检查。先读取 README、PLUGIN-DEVELOPMENT、API-CONTRACTS、M1-PERSISTENCE、ARCHITECTURE 与实际 SDK/Ingress，并核对更新后的边界。M4 只修改自身连接器、工程接入、专用测试和文档；冻结 contracts、plugin-sdk、config、M3 包均未改动。

## 自动化验证

环境：Node 24.11.1、pnpm 11.25.0、TypeScript 5.9.3。初次 frozen install 成功。原有 109 个 Node 测试在允许本机 HTTP 的环境全部通过；沙箱网络限制导致过本地 HTTP 失败，未据此修改 M3。原环境缺少 uv 且默认 Python 3.10 不满足锁定依赖，随后在忽略的 .artifacts 中安装 uv 0.13.6 与 Python 3.13.18，未更改系统安装或冻结依赖。

最终运行 pnpm install --frozen-lockfile 与 pnpm check 成功，包含：

| 检查 | 结果 |
| --- | --- |
| pnpm build | 通过，含三个新 TypeScript project references |
| pnpm typecheck | 通过，原有类型正反例保持 |
| pnpm test | 161/161，通过；其中 M4 新增 23 个（合入新 main 前为 132/132） |
| pnpm check:boundaries | 通过，三个私有包只依赖 SDK |
| pnpm check:freeze | 通过，45 个冻结文件字节不变 |
| pnpm test:reference | 6/6 Python 参考套件通过 |

M4 测试为 Discord 11 项、Steam Reviews 8 项、Discussions 4 项。平台传输为合成 fixture / 注入 fetch 和 WebSocket；存储使用真实文件 SQLite 与生产 Ingress Source Host，包含关闭/重开数据库。不把这些测试称为真实 Discord/Steam 权限验证。

| 用户验收项 | 对应验证 |
| --- | --- |
| 原生事件映射 | 三个平台 fixture 经冻结 NormalizedEvent Schema；原文/作者/语言/附件/时间/链接/标题 |
| 相同事件重放 | 真实 Host refs 返回相同 InternalEventId，与源 ID 区分 |
| 独立历史 | Discord 编辑/删除/批量删除、评价差评转好评、快照编辑/删除保留旧事件 |
| 整批回滚 | 非法原生评价、源身份错误、同 ID 内容冲突；旧事件数及 checkpoint 不变 |
| 重启和失败 | Reviews/Discord 历史、Gateway session/sequence、Discussions 修订状态跨实例和数据库重开；注入提交失败不推进 |
| 限流/网络/权限 | 429 等待、断网重试、5xx 预算、403/Intent/History 权限不足；报告 unavailable 并保留游标 |
| 讨论关联 | 独立 thread 路由、回复父对象、跨 thread 错误拒绝 |
| 覆盖与缺口 | 初始 unknown、默认 Discussions unavailable、可用快照 partial、不可 Resume 的显式 gap；无虚假 full |

另外覆盖心跳 ACK 丢失、Gateway Resume 重放、失败 dispatch 后的排队屏障和不可信 resume URL 拒绝。更新票数不冒充新玩家反馈，但实际文本修订保留该次元数据。

## 真实 API 与 CLI

| 场景 | 实际结果 | 证明范围 |
| --- | --- | --- |
| Steam GetAppReviews 公开 GET，AppID 570，无密钥，1 条 | HTTP 200，response 中含 reviews/cursor；recommendationid 为字符串 | 官方读取端点和实际响应形状可用 |
| Steam 独立 source:m4 CLI，AppID 570，最多 1 页/20 条 | 5 条差评原文进入既有 Source Host；5 次 Admission 完成；checkpoint 保存未完成分页；coverage=partial | 真实公开读取 → 标准事件 → M1 原子持久化链路 |
| Steam AppID 480 小请求 | HTTP 200、response={}，不能确认有效评价列表 | 不把缺失列表当作成功空页，不声称目标 App 可采 |
| 旧 appreviews 小请求 | 本次响应未解析为 JSON | 环境中的一次观察；未把它当作全球端点状态或自动降级依据 |
| Discussions snapshot CLI | 合成文件 4 条事件入库，2 个线程分段，coverage=partial | 真实本地文件/Host 链路；不是 Steam 远程采集 |
| Discord Bot / Guild / Thread | 未执行真实联调，缺少目标配置和授权凭据 | 不能证明 Message Content Intent 或实际频道权限 |
| Steam 目标 App / publisher key / 修改评价 | 用户尚未指定目标；未验证发行商密钥或真实评价状态修改 | 公开 AppID 570 冒烟不能代替目标验收 |

冒烟数据库、分页状态和完整日志位于 .artifacts，未加入 Git。没有调用 M3 Worker、创建 GitHub 业务工单、发送通知或修改外部评价/消息。

## 已知限制与未完成

Discussions 远程自动采集当前 unavailable，已交付 [调查与降级报告](M4-STEAM-DISCUSSIONS-RESEARCH.md)；本地快照需要运营方自行准备有权使用的数据，不能证明远端覆盖。

Discord 仅指定 ID 白名单；不自动发现新/归档线程、不协调多 shard。REST 最近页可回扫编辑，更旧编辑、离线删除与中间历史未必可恢复。原文缺失的部分 UPDATE 不伪造正文。Gateway 与 REST 可能保留同对象的不同观察。需要实际 Bot/Guild/Intent/频道/私有线程联调后才能验收该部署权限。

Steam 是公开当前快照，不能恢复已删除评价和所有中间修订；回扫窗口外才暴露的数据可能遗漏。已追踪差评的 checkpoint 随对象量增长，需要监控序列化成本。没有针对目标生产 App 的全量扫完或高负载平台限流验收。

一个来源只能有一个活跃实例；配置对象集合变更应新建来源。网络重试有预算，持续故障需进程管理器重启；Host/契约保留的同秒歧义修订和迟到事件仍交由现有 reconciliation 流程，不在 M4 中另行解决。

使用入口与逐项限制见 [M4-CONNECTORS.md](M4-CONNECTORS.md)。QQ、Agent 识别质量、GitHub 业务逻辑、半日报和 Web 不属于本次交付。
