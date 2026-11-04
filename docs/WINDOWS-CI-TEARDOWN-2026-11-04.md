# Windows CI 不退出排查（2026-11-04）

## 证据与原因

PR #7 的 Windows job 停在 pnpm check 的 Node 测试阶段。安装、冻结检查、构建和类型检查已完成；Ubuntu 同提交成功。最新两轮 [push run](https://github.com/fangbm/SuperAgent/actions/runs/41769419601/job/126375357329) 与 [PR run](https://github.com/fangbm/SuperAgent/actions/runs/41769423603/job/126375370189) 均在 application-e2e.test.mjs 的四个测试完成后报告失败，之后约 53 分钟没有继续，直到用户取消。取消后的全批 pending/cancelled 不是其他测试都存在独立故障的证据。

失败栈指向 application-helpers.mjs 的 rmSync：删除 superagent-application-* 时 EPERM，SQLite 仍被应用持有。appFixture 先注册删除目录的 t.after，后续用例才注册 app.close、服务器关闭和 worker 等待；node:test 按注册顺序运行 after，首项抛错后不继续剩余钩子。因此删除失败阻止了真正的资源释放，留下 HTTP 服务器、插件心跳和轮询，使测试文件进程不退出。

2446d7f 的 [Windows job](https://github.com/fangbm/SuperAgent/actions/runs/41764248839/job/126358788754) 也有相同 EPERM 与挂起，说明不是后续 60 分钟预算恢复造成。CI 为 Node 24.22.2，本机此前完整检查使用 24.4.0。使用 nodejs.org 提供的 24.22.2 Windows x64 在本机复现同样四个失败及进程不退出，随后定向终止本轮复现进程。两版本的小型实验均显示同样的钩子顺序及首项失败中断后续钩子，未将问题归因为钩子顺序在版本间改变，也未推断具体 SQLite 内部锁行为的变化。

## 修复

appFixture 只注册一个 node:test after，并提供 f.after 收集资源清理函数，逆序逐一 await：最新 worker/应用 → 模型服务器 → 临时目录。每一步清理失败仍执行剩余函数，最后用 AggregateError 保留错误，不吞掉异常。所有应用集成测试的清理迁到同一栈，包括模型服务器和子进程；子进程被杀后等待 exit 再删除文件。没有更改正式应用、Supervisor、Core 或插件实现，没有跳过测试或用强制退出掩盖句柄泄漏。

Workflow 加入 job timeout-minutes:10，防止未来的退出回归占用 runner 数小时；这是兜底，不替代清理修复。未降低 Node 版本，仍按原矩阵测试当前 Node 24 与 Ubuntu/Windows。

## 本机验证

- CI 同版本 Node 24.22.2 / Windows：pnpm install --frozen-lockfile 与完整 pnpm check 通过，293 项 Node 测试、6 组 Python 参考验证，build/typecheck、边界和 45 冻结文件全部通过；进程正常退出。
- 应用专项 42 项通过，包含统一入口 E2E、生命周期、SIGTERM 处理、实际崩溃恢复和稳定预算测试。子进程清理等待调整后再次重跑专项通过。
- 新增两个清理回归：异步资源先关闭后删除真实 SQLite 目录；清理函数抛错仍释放 SQLite/目录且保留原异常。
- 未操作真实平台或生产数据，M0、运行配置默认值和 contracts.freeze.json 未改。远端 CI 结果以修复提交的新运行记录为准，本说明不将本机通过等同为远端通过。
