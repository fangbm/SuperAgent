# QQ 私聊半日报渲染与导航 ADR (v0.6)

**决定**：半日报使用 Markdown + Keyboard（取消 ARK 23 默认方案），下方按顺序显示 `查看 Bug` / `查看建议` / `查看 Steam 差评`。报告固定每日北京时间 18:00、00:00 推送，Web 控制台独立归档。

## 内容与导航约定

- QQ markdown 正文是概览，不承载全部玩家原文；包含时间段、Bug/建议/Steam 差评计数、主要问题、采集覆盖率与待分析量。
- `查看 Bug`：查询本半日报窗口内有新反馈的 Issue，先返回最多 3 条摘要，二级 `Details` 返回所有关联玩家原文的分页页码。
- `查看建议`：同上，改用 Suggestion 及建议生命周期操作。
- `查看 Steam 差评`：查询 `steam-reviews` 来源，在本窗口收到新增/更新且当前评价为负面的 review 记录，按 Review ID 去重，按接收时间排序，最多 3 条/页；展示**不改写原文**、来源时间和可信外链。可提供关联内部 Bug，但不是唯一数据入口。
- 回调只做只读检索，不调用 LLM 或 GitHub 写接口。
- Steam 数据源如果失效，显示 `采集不完整`，而不是“无差评”。

## QQ payload（示意，实际需要权限实测）

```json
{
  "msg_type": 2,
  "markdown": { "content": "# 🎮 游戏反馈半日报\n\n**新增 Bug：** 8\n**玩家建议：** 12\n**Steam 差评：** 4" },
  "keyboard": {
    "content": { "rows": [ { "buttons": [
      { "id": "report_bugs", "render_data": { "label": "查看 Bug", "visited_label": "查看 Bug", "style": 1 }, "action": { "type": 1, "permission": { "type": 2 }, "data": "<opaque-token-for-bugs>" } },
      { "id": "report_suggestions", "render_data": { "label": "查看建议", "visited_label": "查看建议", "style": 1 }, "action": { "type": 1, "permission": { "type": 2 }, "data": "<opaque-token-for-suggestions>" } },
      { "id": "report_steam", "render_data": { "label": "查看 Steam 差评", "visited_label": "查看 Steam 差评", "style": 1 }, "action": { "type": 1, "permission": { "type": 2 }, "data": "<opaque-token-for-steam>" } }
    ] } ] }
  }
}
```

> 内联 JSON 是示例载荷；不透明 token 由 Host 为每个 reportId、recipientRef、section 发行并附有效期。示例 `permission.type=2` 不等于服务端授权；必须根据 `user_openid` 与开发者白名单重新认证。

## 操作流程

1. 插件发送包含 `ReportPresentationV1` 的 `DeliveryRequestV1`；Host 根据 reportId 获取报告快照并生成 Markdown 和 token；QQ 插件将抽象 actions 映射为 Keyboard。
2. QQ 回调 `INTERACTION_CREATE`，插件验证 `scene=c2c`、`type=11`、原消息、令牌与身份；交互 ID 全局去重；及时回应 interaction API。
3. Host 读取报告 `reportId + revision` 稳定快照；查询 `ReportNavigationPageV1`，仅向同一已授权开发者 QQ 私聊发送列表/原文；默认每页 3 条。
4. 后续 `Details`、`下一页` 按钮延用相同作用域，不将 SQL、平台 OpenID 或访问凭据暴露在 `button_data`。
5. 超时/响应未知沿用 ExternalOperation 状态机：不直接盲目发送第二条主动消息。

## 功能降级

- 没有 Keyboard：Markdown 正文 + 文本指令 `/bugs`、`/suggestions`、`/steam-negative`。
- 没有 Markdown：纯文本 + 同样指令。
- 发生授权或数据异常：后台审计并在私聊返回简短错误；不可泄露原文。

## 测试边界

Schema 仅测试渲染前的抽象结构。QQ 官方消息 payload 的确切参数、主动 Markdown、按钮回调与当前机器人权限必须通过真机端到端验证。

## v0.7 通知分流补充

此 Markdown + 三按钮半日报是**非 P0 反馈的唯一自动 QQ 推送汇总**。P0 Bug 允许单独实时 QQ 告警；已告警 P0 仍包含在本报告里并展示送达状态。除 P0 外禁止单条 Bug、Steam 差评或建议即时通知。用户主动点击按钮后的交互回复不算自动推送。详见 `NOTIFICATION-POLICY.md`。

## v0.8：报告不可变快照绑定

- 点击按钮 token 固定携带签发时的 `reportId + revision + section + recipientRef`（可采用服务端不透明 token），不可默认为最新修订。
- 仅读已 seal 的不可变报告快照； `ReportV2.schemaVersion=2.1` 必须有 `revision>=1`、`snapshotCutoffAt`、`steamNegativeReviews`；报告列表来自 `report_snapshot_entries`。
- Steam 差评详情来自 `report_steam_negative_reviews` 引用的 `source_events(event_id)` 原始不可变证据，快照成员每个 `sourceId + reviewExternalId` 唯一，窗口内触发事件必须记录。
- 老版本没有成员清单时禁止临时从当前 Steam API 查询并声称是原报告；可以展示历史快照不可用。
