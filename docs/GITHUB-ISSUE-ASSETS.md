# 原生 Issue 附件和开发报告

PR 顺序：A [#15](https://github.com/fangbm/SuperAgent/pull/15) 结构化报告 → B [#16](https://github.com/fangbm/SuperAgent/pull/16) 私有附件捕获 → C [#17](https://github.com/fangbm/SuperAgent/pull/17)。三个均为 Draft，不自动合并。当前 main 不因这些 PR 自动启用任何下载/发布。

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

两类 token 可分开提供，Issue token 负责现有正文/评论，附件 token 需被上传端点接受并有对应私有仓库写权限。本轮已实测本机 gh 登录凭据可上传图片，不能由此推断所有 PAT 或 App 安装 token 都可用。配置只给环境变量名称，不把 token 存入数据库或示例，正式入口不自动提取 gh 凭据。主 GitHub 写入关闭时不能单独打开附件写入。仍使用唯一正式入口 `pnpm start --config ...`；没有上传 daemon、Cookie 自动登录或独立证据仓库。

## 行为

- 图片直接作为 GitHub 原生附件展示，不落到仓库 Git 历史。QQ 本地捕获支持 PNG/JPEG/WebP 与 UTF-8 日志；原生上传端点本轮拒绝 text/plain 日志（HTTP 422），因此不能声称普通文件直传已可用。失败保留本地文件和文字报告，不改成公开图床或仓库提交。用户内容不作为代码执行。
- 文件绑定原始事件及 assetRef，只发布工作项 active primary 证据对应的文件，不因截图时间近、同名或其他工作项上下文就自动关联。图片语义仍未分析/确认。
- 新 Issue 使用当时已有报告/附件，失败或迟到不阻塞文字报告创建。成功后自动更新机器人报告评论；即使工作项版本没变也能更新。报告哈希相同不重复刷新。
- 超时 unknown 不重复上传；有已保存 URL 时仅只读对账，无 URL 时保留状态与错误供人工复核。私有性/授权/哈希校验失败不曝光附件链接。持续验证失败会停止；明确限流遵守等待和有限预算。
- 人工 Issue 正文不覆盖；人工改机器人专用评论会暂停同步，不因后续附件变化自动解除暂停。

## 验证与边界

完整 `pnpm check`：**531 项 Node + 6 组参考验证通过**，包含构建、类型、包依赖边界和 45 冻结文件检查。包含 12 项受控附件发布集成测试、Unicode 截断回归、3 项默认配置测试和 2 项 DoH 传输回归。覆盖迟到/并发完成、文件失败仍建 Issue、同版本内容哈希、上传与本地确认失败后不重传、恢复只读验证、私有目标/撤权/匿名拒绝、人工编辑、原始 PNG/日志请求与重定向去凭据、关闭及显式配置、Retry-After、默认继承、未使用密钥和显式关闭、DNS 公开地址固定及保留地址拒绝。

2026-11-05 已在私有测试仓库 fangbm/sa-test 做真实原生上传：1 张 68 字节合成 PNG 上传一次，授权读取 SHA-256 一致，匿名稳定地址返回 404，附到 [测试 Issue #5](https://github.com/fangbm/sa-test/issues/5) 并读回正文。1 份 110 字节合成日志上传一次被 HTTP 422 拒绝。共 2 次上传 POST，无自动重传、无玩家数据、无模型调用、无 QQ 群发送。图片初次读取发现 GitHub 实际重定向至 github-production-user-asset-6210df.s3.amazonaws.com；补入精确域名允许列表后只读复核成功，Bearer 不转发给 S3，签名 URL 不持久化。本机 S3 直连 TLS 失败，验证子进程显式使用已有本机代理与 NODE_USE_ENV_PROXY=1；未改系统代理。生产网络同样须可达 GitHub 内容域名。

本轮 QQ CDN 下载验收见 QQ-ARTIFACT-ACCEPTANCE.md，不能将原生上传与受控 Source 测试当作真实 QQ 下载已通过；Claude Code 实际读取也未运行。官方 CLI 文档目前只承诺图片/媒体，纯文本文件拒绝是实际平台限制，不是成功验收。

第一次完整回归遇 Windows spawn EBUSY（子进程未启动），未因此放宽断言或跳过用例；后续完整检查通过。GitHub Actions 账户计费限制仍与这些本地结果分开，不把未启动的远端任务写成通过。协议来源与迁移/信任决策见 ADR 0023。
