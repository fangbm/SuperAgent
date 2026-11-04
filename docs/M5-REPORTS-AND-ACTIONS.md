# M5 报告、操作与本地控制台

M5 新增 reporting、control-plane、web-console 三个私有包及迁移 009。公共 contracts、SDK、Schema、fixtures 和默认配置保持 M0 冻结版本。平台插件仍只依赖 SDK；可信启动器组合 Host 与插件。

## 本地启动

整套系统的正式入口为 `pnpm start --config config/superagent.json`，通过同一配置启用模型、来源、Web、报告和 Delivery；不另开 M3/M5 Worker。详见 [统一主程序](UNIFIED-APPLICATION.md) 和 [项目状态](PROJECT-STATUS.md)。以下 demo/start:m5 为独立调试入口，不能与正式进程操作同库。

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm demo:m5
```

打开终端输出的 localhost 地址，使用演示访问密钥 `superagent-demo-access-key-for-local-review`。每次 demo 创建独立 SQLite 数据库，使用确定性模拟分析器和合成 QQ/Discord/Steam 事件，不调用模型、不发送消息。Web 仅监听 127.0.0.1，没有部署公网服务。

已有数据库：

```powershell
pnpm start:m5 --database .artifacts/local.sqlite --project my-game
# Windows 当前用户可在自己的终端查看本地访问密钥：
pnpm m5:key --show
```

Windows 默认在 `.artifacts/m5-access.dpapi` 加密保存随机访问密钥和独立游标签名密钥。其他平台必须提供 `SA_WEB_ACCESS_KEY`（至少 32 字符），可另配 `SA_CURSOR_SIGNING_KEY`；只读账号可用 `SA_WEB_READER_KEY`。应用不自动加载 `.env`。首次升级已有数据库会先用 SQLite backup API 保存迁移前副本至 `.artifacts/backups`；原始迁移不修改。

Web 支持总览、报告修订归档、Bug/建议、原文分页、状态操作、反馈移动/拆分/合并、处理记录、来源覆盖、队列及对外操作状态。读账号不能取得写令牌；会话逐请求重新核对当前账号权限。HTTP 使用限定 Host/Origin、SameSite 会话、CSRF、CSP 与登录限速。该入口仅供本机使用。

报告摘要按 Markdown 排版，标题、列表、强调、引用、链接与代码块由服务端解析后展示；派生 HTML 接口绑定账号、项目及封存修订，原报告 JSON 不改写。原始 HTML 显示为文本，图片不自动加载，仅允许 HTTP(S) 或页内链接。来源原文继续保持字面内容和换行，不作为 Markdown 执行。参见 [ADR 0008](ADR/0008-web-report-markdown.md)。

## 固定窗口与快照

北京时间 00:00—18:00 和 18:00—次日 00:00 为两个固定半开窗口，结束后等待 180 秒宽限期。统计以 Host `received_at` 归属窗口，原始发生时间单独展示；调度持久化 `next_end`，重启后每次最多补 20 个窗口。新装默认从最近到期窗口开始，历史补报可由 ReportService 显式登记起点。

反馈项、Bug/建议去重数量和独立来源事件数量分别计数，未分析候选继续显示 pending。Steam 栏只接受该窗口触发的评价对象，按来源和评价 ID 去重，使用截止时已观察到的最新状态；最新为好评或删除的对象不列入差评。Steam Reviews 已实现负评/全评价采集，评论和 Discussions 作为独立来源参与通用反馈分析；差评栏目不会把评论或主题冒充评价成员。统计回归使用合成事件，真实有界采集范围另见 [Steam 运行说明](STEAM-PUBLIC-FEEDBACK.md)。

报告 JSON、排序成员、Steam 触发事件、工作项原始证据锚点与 seal 在一个事务提交。复合 SHA-256 覆盖快照和成员行；读取核对完整性。新修订另存，旧报告按钮和原文页固定原修订。原文后来删除时返回不可见占位，保持成员位置。只有首版自动创建投递意图，新修订不会重复主动发送。

## QQ 与外部操作

```powershell
pnpm start:m5 --database .artifacts/local.sqlite --project my-game --qq-configured --qq-source --source qq-main --protected-config .artifacts/qq-config.dpapi
```

以上独立 start:m5 默认只准备投递、不发送。实际发送另加 `--qq-write`，可用 `--max-sends 4` 限制本进程最多处理的发送尝试。`--qq-readonly` 将 QQ 操作者设为只读，适用于导航验收；Web 开发者身份独立。独立运行器不安装模型 worker，调试流程需自行安排分析并避免同库并发；正式入口已在配置启用后管理 M3，无需另开 worker。

聊天中临时开启的限额预览不是持续运行的服务：每次导航回复（包括返回半日报）均占一次额度，截止时间或额度先到即停止。停止后的 QQ 按钮回调会因没有在线接收端而失败，不能用来判断栏目渲染是否正确。继续验收需另开明确范围的新会话，既有失败或积压点击不自动补发。

QQ 使用已绑定开发者 OpenID，控制请求不进入玩家反馈。点击半日报的 Bug、建议或 Steam 差评，直接进入内容卡，显示一条反馈的摘要、当前状态和首条原文；上一条/下一条切换同栏目成员，返回半日报固定原报告修订。短原文一次看完，超过 800 个代码点时“继续原文”接续完整分页，有多个来源时可直接看下一条原文。只读账号只显示导航，开发者账号另有当前允许的状态操作。历史列表、详情和原文按钮继续可用。

支持 `/reports`、`/bugs`、`/suggestions`、`/steam-negative`、`/open TOKEN`，分类命令也直接打开内容卡。按钮使用不透明令牌并绑定操作者、项目与修订；回调持久入队后 ACK，耗时处理另行进行。Gateway 的 intents 变化会使旧 Resume 会话失效并重新 Identify。

主题原文同时展示已归档的标题和正文，模型抽取和 Bug/建议匹配也能读取标题；原文分页与授权继续使用同一证据 ID。Web 支持反馈移动/拆分/合并，QQ 当前只提供导航和状态动作，没有关联纠错入口。

状态更改成功后直接回发同一反馈卡，保留摘要、原文与位置，更新状态标记及可用按钮；不再先固定发送一条静态“等待 GitHub”消息。远端尚未确认时显示等待/核对提示并提供“查看结果”，查询只读已有命令状态。同一项目、收件人和绑定下，新消息受理后自动撤回两分钟内的旧交互消息，包括重复查询、列表、内容卡、原文分页、Steam 和提示。**半日报不撤回**：定时推送、`/reports` 和“返回半日报”均保留，也保护旧版报告及尚未发出的报告撤回任务。超时不撤回，新消息发送 unknown 时保留旧消息，撤回 unknown 不重试。只清理有 Host 成功发送记录的机器人展示消息，数据库原文、报告和审计均保留。规则见 [ADR 0009](ADR/0009-qq-action-cards-and-retirement.md)。

发送样式由 [原始 Markdown 模板](../packages/reporting/templates/qq/README.md)定义：半日报先展示本期统计，分类内容卡将摘要与原文同屏，长原文保留独立续读页。时间为北京时间，按钮全部中文。原文页的字面转义在展示层完成，数据库原文和旧投递请求不改写；正常正文不展开长 `/open` 指令。

运行 `pnpm preview:qq` 可生成六张消息的填充示例和离线排版预览，正文及按钮标签来自实际 QQ 控制服务，不发送任何 QQ 消息。新模板用 Host 私有选项避免重复标题，旧记录继续使用原选项。模板重设计已有真实客户端确认，精简导航的真实覆盖范围见 [M5 验收记录](M5-ACCEPTANCE.md)；证据按版本分别留档。

报告只在已知、明确的格式拒绝下逐级降级为无键盘 Markdown 或纯文本命令。超时、连接中断或崩溃后的 unknown 保持未知，不重发。accepted 仅为 API 受理；实际送达必须另有客户端确认。按钮回调和原文回复需要真实平台权限，模拟成功不证明该账号已开通。

状态动作共用 ControlPlane/DomainService，检查角色、项目、一次性令牌、版本和交互幂等身份，记录审计。拒绝/忽略须有理由；QQ 使用明确选择动作的固定审计理由，详细说明可在 Web 填写。GitHub 关联 Bug 的修复、忽略、重新打开先存为 pending_remote，只 PATCH state/state_reason，读回确认后才更新本地。并发远端状态冲突进入人工复核。启用另需 `SA_GITHUB_REPOSITORY`、`SA_GITHUB_TOKEN` 和 `--github-write`，目标必须为私有仓库。模型没有收件人或发送权限。

M5 包本身不负责来源采集或模型执行，这些由统一应用的 Source 与 M3 负责。P0 实时调度、多租户公网部署仍未交付；相关历史验收见 [M5 验收](M5-ACCEPTANCE.md)，当前跨模块状态见 [项目状态](PROJECT-STATUS.md)。
