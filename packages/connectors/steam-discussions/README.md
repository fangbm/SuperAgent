# Steam Discussions Source Plugin

默认报告 unavailable，不承诺远程采集。已实现显式 mode=snapshot 本地快照降级，通过现有 SourcePluginV1 / Source Host 提交主题、回复和明确修订/删除；仅依赖 plugin-sdk 与 Node 24 内置模块。

[能力调查及候选访问方式](../../../docs/M4-STEAM-DISCUSSIONS-RESEARCH.md) 解释当前边界。配置样例为 examples/config.json 和 examples/snapshot-config.json，数据格式参照 tests/fixtures/m4/discussions.json。

独立运行、原子文件替换、大小上限与 checkpoint 说明见 [M4 使用文档](../../../docs/M4-CONNECTORS.md)；[验收记录](../../../docs/M4-ACCEPTANCE.md) 明确区分本地快照测试和 Steam 端权限验证。
