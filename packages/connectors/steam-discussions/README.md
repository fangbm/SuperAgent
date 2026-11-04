# Steam Discussions Source Plugin

默认报告 unavailable，不承诺远程采集。`mode=public` 显式启用匿名 Steam 公共讨论采集；`mode=snapshot` 保留本地快照降级。两者都通过现有 SourcePluginV1 / Source Host 提交事件和 checkpoint。

Public mode uses a 10-minute poll interval, 2-second minimum request spacing, 25 actual HTTP requests per sync (retries count), and a 24-hour revisit interval for known topics. It discovers topic pages and reads public replies only. Private topics, deletions, attachments, and intermediate edits cannot be recovered. Requests never use login cookies or session data. See `examples/idle-abyss-princesses-public.json` and [the implementation work notes](../../../docs/STEAM-DISCUSSIONS-PUBLIC-WORK-NOTES.md).

[能力调查及候选访问方式](../../../docs/M4-STEAM-DISCUSSIONS-RESEARCH.md) 解释当前边界。配置样例为 examples/config.json 和 examples/snapshot-config.json，数据格式参照 tests/fixtures/m4/discussions.json。

独立运行、原子文件替换、大小上限与 checkpoint 说明见 [M4 使用文档](../../../docs/M4-CONNECTORS.md)；[验收记录](../../../docs/M4-ACCEPTANCE.md) 明确区分本地快照测试和 Steam 端权限验证。
