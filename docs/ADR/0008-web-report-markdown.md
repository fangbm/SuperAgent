# ADR 0008：Web 报告 Markdown 展示

日期：2026-11-03。状态：已采用；本地检查通过，用户人工复核确认“显示和操作都正常”。自动浏览器视觉工具不可用，人工确认与自动检查分别留档。

Web 人工验收发现报告摘要直接放进 pre 标签，Markdown 标题、列表等显示为源文本。报告摘要改为通过鉴权后的 GET `/api/reports/:id/:revision/content` 获取派生 HTML，前端在独立 report-content 容器展示，并补充标题、列表、引用、链接和代码排版。服务端仍先验证操作者、项目和精确封存修订。报告 JSON 中的 markdown 与 seal 均不改写；既有 JSON 接口保持原返回结构。

使用 CommonMark 0.31.2 解析 AST，由 Web 层的允许列表输出 HTML。支持标题、段落、嵌套列表、强调、引用、代码、分隔线和 HTTP(S)/页内链接。原始 HTML 作为文本转义，图片只保留替代文本，不自动加载资源；链接不允许脚本、数据、文件或带账号密码的 URL，外部链接使用 noopener/noreferrer。CSP 保持原限制，不引入 CDN 或远程脚本。前端只接收该鉴权接口的渲染结果，不直接将报告 Markdown 或玩家文本插入 innerHTML。

玩家原文仍使用 pre 加文本节点，保留原始 Markdown、代码及 HTML 字面内容，不套用报告渲染器。原文分页与报告修订绑定逻辑保持原样。

commonmark 增加为私有 web-console 包的生产依赖，类型声明仅为开发依赖。LinkeDOM 仅用于开发测试：运行真实前端脚本、请求本地 HTTP 服务并验证报告元素和字面原文。该模拟 DOM 不证明浏览器视觉效果。未修改冻结 contracts、SDK、Schema、fixtures、默认配置或数据库迁移。

依据：[CommonMark 解析与 AST 文档](https://github.com/commonmark/commonmark.js)、[LinkeDOM 文档](https://github.com/WebReflection/linkedom)。
