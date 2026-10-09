# v0.5.0 Release Gate 修复与验收记录

日期：2026-10-09。源码基线：`cdcb093f6a94`。本记录包含本地修复与后续 Unix PTY 清理，远端结果以 PR 的候选 SHA CI 为准。

## 已实施的源码修复

- PR 合并、Review Comment、Worktree 删除、Agent 关联清理和人工确认统一使用 Tauri 原生确认，取消/不可用均拒绝执行。异步确认结束后重新校验 PR/工作区/草稿。
- Native Run Registry 支持按规范工作区路径查询和重新附着，原子预留 ID 与运行槽；保留 Profile、输出、退出码和状态。Stop 请求为 stopping，确认退出后才进入 stopped。
- 后台 Run/Build/Agent 使用 ManagedChild：Windows 挂起启动后加入 Job Object；Unix 独立进程组、TERM/KILL 升级及退出观测。清理未确认时继续占用运行槽并显示诊断。
- Terminal 启动先预留 ID，停止使待启动任务失效，失败回收；上限八个会话，增加独立 Close 操作。Unix 清理覆盖同一会话内所有前台/后台作业组，TERM/KILL 升级并确认退出；WNOWAIT 在 shell 退出但后台任务仍持有 PTY 时触发清理。Stop、取消、EOF、应用退出共享清理路径，失败保留会话待重试。
- Codex 初始化与归属串行化；CLI 停止阻止新 Turn；应用退出后拒绝排队的新任务。
- Windows 工具和四种 Agent 复用 launcher 解析，跳过扩展名为空的 POSIX shim，依赖 Rust 标准库执行批处理转义。
- Watcher 代次校验与过期启动补偿清理。
- 生产 CSP 限定本地脚本/IPC，保留 Monaco 本地 worker、blob worker 和内联样式；开发 CSP 单独允许 Vite loopback。
- Agent 单事件 payload 超过 16 KiB 时截断；侧栏不再只展示前六个 Worktree。

## 自动化证据

以下为 Windows 与 WSL Ubuntu 24.04 自动化证据；不能代替三平台真实桌面验收。

| 检查 | 状态 |
| --- | --- |
| npm ci --no-audit --no-fund | 通过；esbuild 安装脚本被 npm 默认策略跳过，实际 Vite 构建通过 |
| frontend typecheck | 通过 |
| frontend production build | 通过；保留现有大 Monaco chunk 警告 |
| 原生确认/Run 重新挂载/Terminal Close/Agent 字节预算 | 通过；前端全量 37 个文件、150 项测试 |
| Windows cargo check --locked | 通过 |
| Windows 子孙清理、父进程先退出、批处理路径及参数保真 | 真实子进程回归通过 |
| Watcher 停止/新启动交错、并发运行槽 | 通过；Rust 全量 68 项测试 |
| Windows acceptance:local | 通过；包含 typecheck、150 项前端测试、68 项 Rust 测试和生产构建 |
| Windows NSIS 候选安装包 | 首次因原输出 EXE 被占用失败；独立 target/rc 成功生成未签名候选包，最终 SHA-256 见同目录 .sha256 文件 |
| Linux cargo check --locked | WSL Ubuntu 24.04 通过 |
| Linux Unix PTY 回归 | 7 项真实 PTY/进程测试通过；旧实现已复现跨组残留与 shell 先退出残留 |
| Linux acceptance:local | WSL Ubuntu 24.04 通过：150 项前端测试、72 项 Rust 测试、typecheck、production build；locked npm 安装通过。随后最终取消重试修订的 Rust 全量为 73 项，通过 |
| macOS acceptance:local | 本机未执行；需候选 SHA 的 macOS runner |

## 必须由真实桌面验收关闭的发布门禁

- [ ] 三平台原生确认框实际出现；取消后没有任何远端操作或删除。
- [ ] Run 启动后切换页签/工作区再返回，输出、Profile、Stop 均可重新附着；立即 Stop、重复启动、退出应用后无遗留子孙进程。
- [ ] Windows npm、Qt/CMake、Keil 与四种 Agent 实际安装/认证；macOS/Linux 对应构建、终端、Agent 回归。
- [ ] 三平台真实 WebView Monaco unified/side-by-side、语言 worker、缩放与 CSP 控制台验证。
- [ ] Windows 安装、卸载、首次启动、升级和数据保留；macOS/Linux 分发包实际安装与回归。
- [ ] 签名、公证、SHA-256、Release Notes 和已知限制经维护者验收。
- [ ] main 必需 CI/分支保护由仓库管理员配置，候选 SHA 三平台 CI 通过。

## 已知限制与后续测量

Run 记录只在本次应用进程内保留。Windows PTY 使用 taskkill 树清理，尚未取得真实交互终端压力验收证据。Unix PTY 已覆盖同一会话中的跨作业组。Linux 需要 5.3+ 内核，使用 pidfd 固定目标，无法使用时安全拒绝清理并报告失败。macOS 等其他 Unix 使用 getsid 后 POSIX kill，仍有两次系统调用之间的微小 PID 重用竞争，不承诺原子身份校验，需真实平台压力验收；主动 setsid 脱离会话的 daemon 不属于终端会话清理范围。后台构建主动脱离进程组的 daemon 也不属于普通构建子孙；本功能不是 OS 沙箱。GBK/CP936 输出尚未增加解码器，不能把 UTF-8 增量解码测试当作 GBK 验证。PR 列表仍有 50 项限制，分页待实现。Git 大仓库 P95/P99、编辑器峰值内存、高速输出压力及全局 Agent 内存预算仍需量化。

未创建 Release、Tag，未修改远端分支保护，未对真实 GitHub PR 执行评论或合并。未签名候选安装包只供验收，不是正式稳定版发布资产。

## 本地候选产物

- 文件：`target/rc/release/bundle/nsis/VirtualLab_0.5.0_x64-setup.exe`（未签名，未安装验收）。
- 此包生成于 Unix PTY 补丁之前，不代表最终 PR 候选 SHA；当时 SHA-256：`fba94eb7362986d416b02bc115ca983386d1c4383489b2dcc59b8a824f081c12`。
- 同目录 `.exe.sha256` 文件可用于校验。
