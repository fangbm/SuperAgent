# QQ Markdown 模板

这里是当前发送器实际读取的原始 `.md` 模板，使用官方支持的标题、加粗、列表、块引用和分隔线。填充器位于 `../../src/presentation.ts`；`{{name}}` 只作单次变量替换，不执行表达式或嵌套模板。

| 文件 | 消息 |
| --- | --- |
| [report.md](report.md) | 半日报总览 |
| [feedback.md](feedback.md) | 当前分类内容卡：摘要、状态与首条原文同屏 |
| [list.md](list.md) | 历史卡片的 Bug、建议或 Steam 差评列表 |
| [list-work-item.md](list-work-item.md) | Bug/建议列表中的单条内容 |
| [list-steam-item.md](list-steam-item.md) | Steam 列表中的单条内容 |
| [work.md](work.md) | 历史卡片的 Bug/建议详情 |
| [evidence.md](evidence.md) | 原文与字符分页 |
| [notice.md](notice.md) | 空状态、操作结果或错误提示 |

标题只显示一次。`bodyIncludesTitle` 是 Host 私有渲染选项，发送器不再为这些新模板另加一行标题；旧记录没有此选项时仍沿用原渲染方式。界面状态与按钮本地化，模型给出的实际标题和摘要不自动翻译。时间显式转换为北京时间，不依赖机器时区。

来自玩家或模型的字段在填充前转义 Markdown；数据库中的原文与报告修订不修改。原文按代码点分页，不摘要、不翻译，也不使用省略号截断原文。`original` 填充的是当前页原文的字面呈现。模板中的空行用于分隔标题、列表及段落；操作按钮由 QQ `keyboard` 单独附加，不在正文展开 `/open` 长命令。

在仓库根目录运行 `pnpm preview:qq`，生成 `.artifacts/qq-template-preview/` 下的六份填充示例与离线 HTML 预览。示例为合成数据，不发送 QQ 消息；CommonMark 预览和本地测试不能代替 QQ 客户端验收。

新导航为“半日报 → 分类内容卡”。点击栏目立即显示一条反馈的摘要、当前状态和首条原文；短原文一次看完，超过 800 字时从第 801 字继续。卡片只保留可用的上一条、下一条、返回半日报、原文续读及当前账号允许的状态操作，不再需要“列表 → 详情 → 原文”。多个来源原文仍可逐条完整翻阅。只读账号不收到状态操作按钮。

预览通过实际 QQ 控制服务生成正文与按钮标签，展示半日报、两条 Bug、建议、Steam 差评和其他来源原文；按钮仅示意。旧 `.md` 模板保留以兼容已经签发的历史卡片令牌。

依据：[QQ 官方 Markdown 文档](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/markdown.html)。不使用该页未列出的表格、折叠区或代码围栏。
