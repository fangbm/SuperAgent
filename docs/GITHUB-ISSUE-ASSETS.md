# 原生 Issue 附件和开发报告

PR 顺序：A [#15](https://github.com/fangbm/SuperAgent/pull/15) 结构化报告 → B [#16](https://github.com/fangbm/SuperAgent/pull/16) 私有附件捕获 → C [#17](https://github.com/fangbm/SuperAgent/pull/17)。2026-11-05 已按用户明确授权依次合入 main，并保留提交历史。合并不会自动开启平台父开关、外部写入或部署真实服务；下文保留各轮验收边界。

## 配置

按用户 2026-11-05 的后续要求，附件能力改为默认开启：根 artifacts 和 QQ captureAttachments 缺省为 true；GitHub 已 enabled 时默认启用 attachmentUploads，写入权限跟随原 github.allowWrites。显式 false 仍可关闭。平台父开关不会自动打开，根配置的 QQ/GitHub/Web 均关闭时不创建附件存储、不要求闲置密钥。启用 QQ/GitHub/Web 后需提供并妥善保存 SA_ARTIFACT_KEY（64 位十六进制，32 字节）；缺失或错误时明确拒绝启动，不每次随机生成。

参考 `examples/github-issue-assets/superagent.json`。其中平台仍关闭，附件子开关采用开启/继承默认值。开启所需来源并配置凭据后，GitHub 可按下面设置；attachmentUploads 可省略，单独 tokenEnv 仅在需要不同上传凭据时使用：

```json
{
  "github": {
    "enabled": true,
    "allowWrites": true,
    "repository": "owner/private-repo",
    "tokenEnv": "SA_GITHUB_TOKEN",
    "attachmentUploads": {
      "enabled": true,
      "allowWrites": true,
      "tokenEnv": "SA_GITHUB_ASSET_TOKEN"
    }
  }
}
```

两类 token 可分开提供，Issue token 负责现有正文/评论，图片 token 需被上传端点接受并有对应私有仓库写权限。普通文件使用用户显式配置的上传会话，运行 `pnpm github:session --config config/superagent.json` 隐藏输入并保存 DPAPI 密文；默认读取该配置 SQLite 同目录的 github-upload-session.dpapi，也可指定 attachmentUploads.sessionConfig 或 sessionEnv（二者互斥）。未配置会话不影响图片，普通文件进入 waiting_configuration，不重复请求图片端点。详见 CROSS-MESSAGE-ATTACHMENTS.md。

本轮已实测本机 gh 登录凭据可上传图片，不能由此推断所有 PAT 或 App 安装 token 都可用。配置不包含凭据值，正式入口不自动提取 gh 凭据或浏览器 Cookie。主 GitHub 写入关闭时不能单独打开附件写入。仍使用唯一正式入口 `pnpm start --config ...`；没有上传 daemon、Cookie 自动登录或独立证据仓库。

## 行为

- 图片直接作为 GitHub 原生附件展示，不落到仓库 Git 历史。捕获支持 PNG/JPEG/WebP、UTF-8 日志与基本结构校验的 PDF/ZIP/DMP。普通文件走单独的原生 repository-file 网页上传协议，TXT 已真实上传；不把已拒绝 text/plain 的图片接口改写为成功。失败保留本地文件和文字报告，不改成公开图床或仓库提交。文件不解包、不执行。
- 文件绑定原始事件及 assetRef，经独立附件→反馈关系找到工作项与 Issue。同消息/引用回复且反馈目标唯一时自动确认；未引用的同作者前后 5 分钟附件只提出候选，在工作台“附件关联”确认后发布，不增加独立反馈数。歧义、跨会话、失效证据不强行关联。图片/文件语义仍未分析。
- 新 Issue 使用当时已有报告/附件，失败或迟到不阻塞文字报告创建。成功后自动更新机器人报告评论；即使工作项版本没变也能更新。报告哈希相同不重复刷新。
- 超时 unknown 不重复上传；有已保存 URL 时仅只读对账，无 URL 时保留状态与错误供人工复核。私有性/授权/哈希校验失败不曝光附件链接。持续验证失败会停止；明确限流遵守等待和有限预算。
- 人工 Issue 正文不覆盖；人工改机器人专用评论会暂停同步，不因后续附件变化自动解除暂停。

## 验证与边界

完整 `pnpm check`：**546 项 Node + 6 组参考验证通过**，包含构建、类型、包依赖边界和 45 冻结文件检查。在 531 项基线上新增 15 项跨消息归属、角色/令牌/分页/HTTP/页面 DOM、文件会话/策略、存储网关、文件类型和缺配置等待测试；保留迟到/并发、unknown 不重传、人工编辑与 DNS/SSRF 回归。

2026-11-05 已在私有测试仓库 fangbm/sa-test 做真实原生上传：1 张 68 字节合成 PNG 上传一次，授权读取 SHA-256 一致，匿名稳定地址返回 404，附到 [测试 Issue #5](https://github.com/fangbm/sa-test/issues/5) 并读回正文。1 份 110 字节合成日志上传一次被 HTTP 422 拒绝。共 2 次上传 POST，无自动重传、无玩家数据、无模型调用、无 QQ 群发送。图片初次读取发现 GitHub 实际重定向至 github-production-user-asset-6210df.s3.amazonaws.com；补入精确域名允许列表后只读复核成功，Bearer 不转发给 S3，签名 URL 不持久化。本机 S3 直连 TLS 失败，验证子进程显式使用已有本机代理与 NODE_USE_ENV_PROXY=1；未改系统代理。生产网络同样须可达 GitHub 内容域名。

真实 QQ 下载已于 20:01:49 完成：98,552 字节 JPEG 精确绑定原消息，私有加密保存、授权解密哈希、跨项目/撤权拒绝与重开不重复下载均通过；没有将这张图上传 GitHub，详情见 QQ-ARTIFACT-ACCEPTANCE.md。GitHub 原生图片上传使用另一张合成 PNG，不能冒充同一张图的全链路或 Claude Code 实际读取。

后续显式配置网页登录会话后，21:59—22:00 已真实上传 124 字节合成 TXT 至原生 repository-file，在 [测试 Issue #5 评论](https://github.com/fangbm/sa-test/issues/5#issuecomment-6658664559) 引用后再次确认授权同哈希和匿名拒绝；此前图片 token 端点的 422 仍是历史事实。PDF/ZIP/DMP 尚未逐类型真实上传，跨消息 QQ 场景本轮为受控测试，边界与详情见 CROSS-MESSAGE-ATTACHMENTS.md、ADR 0024。

第一次完整回归遇 Windows spawn EBUSY（子进程未启动），未因此放宽断言或跳过用例；后续完整检查通过。GitHub Actions 账户计费限制仍与这些本地结果分开，不把未启动的远端任务写成通过。协议来源与迁移/信任决策见 ADR 0023。
