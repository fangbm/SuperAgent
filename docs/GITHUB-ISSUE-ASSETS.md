# 原生 Issue 附件和开发报告

PR 顺序：A [#15](https://github.com/fangbm/SuperAgent/pull/15) 结构化报告 → B [#16](https://github.com/fangbm/SuperAgent/pull/16) 私有附件捕获 → C 本功能。三个均为 Draft，不自动合并。当前 main 不因这些 PR 自动启用任何下载/发布。

## 配置

参考关闭状态示例 `examples/github-issue-assets/superagent.json`。按 B 配置稳定的 32 字节私有存储密钥并启用所需 QQ Source/captureAttachments/artifacts。GitHub 部分需逐项显式启用：

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

两类 token 可分开提供，Issue token 负责现有正文/评论，附件 token 必须是上传端点接受的 GitHub App 凭据并有对应私有仓库写权限。配置只给环境变量名称，不把 token 存入数据库或示例。主 GitHub 写入关闭时不能单独打开附件写入。仍使用唯一正式入口 `pnpm start --config ...`；没有上传 daemon、Cookie 自动登录或独立证据仓库。

## 行为

- 图片直接作为 GitHub 原生附件展示；日志/文件原字节按匿名文件名上传并用授权下载链接引用，不落到仓库 Git 历史。支持路径以实际 PNG/JPEG/WebP 或 UTF-8 日志为限，用户内容不作为代码执行。
- 文件绑定原始事件及 assetRef，只发布工作项 active primary 证据对应的文件，不因截图时间近、同名或其他工作项上下文就自动关联。图片语义仍未分析/确认。
- 新 Issue 使用当时已有报告/附件，失败或迟到不阻塞文字报告创建。成功后自动更新机器人报告评论；即使工作项版本没变也能更新。报告哈希相同不重复刷新。
- 超时 unknown 不重复上传；有已保存 URL 时仅只读对账，无 URL 时保留状态与错误供人工复核。私有性/授权/哈希校验失败不曝光附件链接。持续验证失败会停止；明确限流遵守等待和有限预算。
- 人工 Issue 正文不覆盖；人工改机器人专用评论会暂停同步，不因后续附件变化自动解除暂停。

## 验证与边界

完整 `pnpm check`：**525 项 Node + 6 组参考验证通过**，包含构建、类型、包依赖边界和 45 冻结文件检查。新 11 项受控集成测试覆盖迟到/并发完成、文件失败仍建 Issue、同版本内容哈希、上传与本地确认失败后不重传、恢复只读验证、私有目标/撤权/匿名拒绝、人工编辑、原始 PNG/日志请求与重定向去凭据、关闭及显式配置、Retry-After；另补充长 Unicode 报告截断测试，避免截断代理对导致乱码。真实本机 SQLite/文件与受控 HTTP 接口不等于真实 GitHub 接收。

本轮未下载真实 QQ CDN、未向真实 Issue 上传文件、未运行真实 Claude Code 读取。真实上传权限、平台对普通文本文件的接收、私有附件的实际读取和具体 Claude 账号权限仍待有界联调；不能把 API 替身通过写成这些验收通过。官方 CLI 文档目前只承诺图片/媒体，文本请求若被平台拒绝，会保留本地文件、失败状态和文字报告，不切换为公开图床或仓库提交。

第一次完整回归遇 Windows spawn EBUSY（子进程未启动），未因此放宽断言或跳过用例；后续完整检查通过。GitHub Actions 账户计费限制仍与这些本地结果分开，不把未启动的远端任务写成通过。协议来源与迁移/信任决策见 ADR 0023。
