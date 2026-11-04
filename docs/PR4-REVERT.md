# PR #4 回滚与统一入口前置检查

2026-11-04。用户要求以新 Revert Commit 撤销 PR #4，再单独交付统一主程序；两个 PR 均为 Draft，禁止自动合并或部署。

基线：远端 main `66eecc53559ff48f5fcb7f158b7cf154dc3f6f28`（PR #4 合并提交），第一父提交 `448c2cc9b287221b4252750d090c124a4a4d8a46`。原工作区 main 为 `04392e6`，无未提交改动；在独立 worktree 工作，未改动原工作区的数据、凭据或文件。

检查 PR #1–#5 的远端状态：#1（Steam Reviews）、#2（Discord）、#3（Steam Discussions 本地快照降级）均已合并；#4 已合并，其完整变更为 114 文件；#5 仍开放、非 Draft，head 为 `8f29b2949f089d012f42a8cb7689a3d8865eb304`，分支 `fix/core-owned-plugin-ingestion`，本轮不合并或改写。#5 的服务工厂和 Host 绑定可参考，社区功能、source processing_mode 和工单事务扩展不移植。

使用 `git revert --no-commit -m 1 66eecc5` 精确反向应用 #4。恢复 #3 后的树：保留全部 M0/M1/M3/M5/M6 与三个基础 M4 适配器；撤销 Discord 社区、共享网关扩展、Source 级永久 archive_only、Steam 扩展、部署入口及相关测试文档。所有这些源码仍完整保存在原提交和原远端分支中。

用户明确说明尚未产生真实数据，不要求旧库迁移兼容，因此不增加迁移或兼容代码。移除的 012/013 迁移不适用于已升级数据库；既有迁移哈希校验会拒绝这类数据库，不能修改迁移账本强行打开。没有删除本地数据库或凭据，也没有访问或清理 Discord 服务器资源。

验证：`pnpm install --frozen-lockfile` 成功；`pnpm check` 成功，244 项 Node 测试、6 组 Python 参考验证、build/typecheck、依赖边界及 45 个冻结文件检查均通过。验证为本地测试，不代表平台真实权限或服务部署验收。

PR A 仅包含精确回滚及本说明；PR B 在其分支上实现服务组装与插件生命周期，单独验收。
