# v0.5.0 Release Gate 修复与验收记录

> **最新 Release Gate 快照（2026-10-10）**：PR #44 已合并到 `main@e693f4f690d10a6439377e1466e6a828cf54e7e8`。该 SHA 的 [CI](https://github.com/magic-alt/virtuallab/actions/runs/38030779241) 6/6 通过，但最终 SHA 的三平台安装包、真实 GUI、代码签名、公证和 main 必需检查规则尚未关闭。结论：**可进入 RC 实机验收，v0.5.0 Stable 暂不放行**。本页早期 SHA 和测试记录均为历史证据，不应当作当前 HEAD 证明。状态同步在 [Issue #40](https://github.com/magic-alt/virtuallab/issues/40)。

日期：2026-10-09。源码基线：`cdcb093f6a94`。本记录包含本地修复与后续 Unix PTY 清理，远端结果以 PR 的候选 SHA CI 为准。

## 已实施的源码修复

- PR 合并、Review Comment、Worktree 删除、Agent 关联清理和人工确认统一使用 Tauri 原生确认，取消/不可用均拒绝执行。异步确认结束后重新校验 PR/工作区/草稿。
- Native Run Registry 支持按规范工作区路径查询和重新附着，原子预留 ID 与运行槽；保留 Profile、输出、退出码和状态。Stop 请求为 stopping，确认退出后才进入 stopped。
- 后台 Run/Build/Agent 使用 ManagedChild：Windows 挂起启动后加入 Job Object；Unix 独立进程组、TERM/KILL 升级及退出观测。清理未确认时继续占用运行槽并显示诊断。
- Terminal 启动先预留 ID，停止使待启动任务失效，失败回收；上限八个会话，增加独立 Close 操作。Unix 清理覆盖同一会话内所有前台/后台作业组，TERM/KILL 升级并确认退出；WNOWAIT 在 shell 退出但后台任务仍持有 PTY 时触发清理；适配 Darwin 的退出 leader getsid 不可见、zombie-only 进程组 EPERM。Stop、取消、EOF、应用退出共享清理路径，失败保留会话待重试。
- Codex 初始化与归属串行化；CLI 停止阻止新 Turn；应用退出后拒绝排队的新任务。
- Windows 工具和四种 Agent 复用 launcher 解析，跳过扩展名为空的 POSIX shim，依赖 Rust 标准库执行批处理转义。
- Watcher 代次校验与过期启动补偿清理。
- 生产 CSP 限定本地脚本/IPC，保留 Monaco 本地 worker、blob worker 和内联样式；开发 CSP 单独允许 Vite loopback。
- Agent 单事件 payload 超过 16 KiB 时截断；侧栏不再只展示前六个 Worktree。

## 自动化证据

以下包含 Windows、WSL Ubuntu 24.04 和 macOS 自动化证据，各记录以注明的源码基线为准；不能代替三平台真实桌面验收。

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
| Linux acceptance:local | WSL Ubuntu 24.04 通过：150 项前端测试、72 项 Rust 测试、typecheck、production build；locked npm 安装通过。随后加入取消重试与 macOS zombie 兼容回归，最终 Rust 全量为 74 项，通过 |
| macOS acceptance:local | PR #43 候选 `86ea91f` 本机通过：155 项前端测试、77 项 Rust 测试、typecheck 和 production build；详见下方 macOS 记录 |

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

## 2026-10-09 最新 main 与后续 Release Candidate

PR #41 和 #42 已并入 main `cea4655bb1196d556a2ed88cc047c9bb41dbc27b`；本文件开头记载的 `cdcb093f6a94` 是原始审查基线，不应理解为当前 main HEAD。PR #43 从该最新基线建立 `release/v0.5.0-rc-qualification`，补充跨平台 Agent 工作区身份修复、真实 OS Runner 的未签名候选安装包构建、版本/SHA-256 清单和 Release Gate。详见 [RELEASE_CANDIDATE_CHECKLIST.md](RELEASE_CANDIDATE_CHECKLIST.md)。

所有安装、认证、真实 GUI、签名/公证及 main 分支规则仍由维护者按核验记录关闭；不能根据 PR CI 的绿色状态自动发布。

## PR #43 macOS 本机验证记录（2026-10-10 整理）

验证对象：`86ea91f15d59ba8174bf0f2db5ecbd64600114b0`。使用该提交的 `git archive` 在独立临时目录验证，未修改源码。环境：macOS 26.7.1（25G241）、Apple Silicon arm64、Node 26.0.0、npm 12.0.2、Cargo 1.98.1。以下结果仅适用于该候选，不代表后续文档提交已重新通过 CI。

| 检查 | 结果 |
| --- | --- |
| `npm ci --no-audit --no-fund` | 通过；安装 184 个包，两个锁文件保持不变 |
| `version:check` / `icons:check` | 通过；版本统一为 0.5.0 |
| `node --test scripts/rc-assets.node-check.mjs` | 3 项通过 |
| `acceptance:local` | 沙箱外完整通过：typecheck、155 项前端测试、production build、77 项 Rust 测试；另跳过 1 项 Windows 专用 doctor 测试 |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml` | 通过 |
| `tauri:build -- --bundles app` | 通过；`.app` 19.67 MiB，Mach-O arm64，包内版本 0.5.0 |
| 实际包内 ICNS | 字节一致性、`iconutil`、`sips` 和 Swift 原生解码通过；1024×1024，orange=13010、dark=34498 |
| `rc-assets.mjs package macos` / `verify macos` | 使用完整候选 SHA 通过；独立 `shasum -a 256 -c SHA256SUMS.txt` 通过 |

首次沙箱内 Rust 测试为 71 项通过、6 项失败，原因是 `/bin/ps` 进程检查被沙箱拒绝（`Operation not permitted`）；同一源码在沙箱外重跑 77 项全部通过。Swift 模块缓存改用临时可写目录后原生图标检查通过。npm 默认策略跳过 esbuild/fsevents 安装脚本，实际构建通过；保留现有 Monaco 大 chunk 警告。

本地未签名 QA 产物：`VirtualLab_0.5.0_macos_qa-unsigned.zip`，6,844,989 字节。

```text
SHA-256: d3fc907136cee9c9c7b4094cdbd376839d493853196c5250b84e651a5cf7df6e
sourceSha: 86ea91f15d59ba8174bf0f2db5ecbd64600114b0
signed: false
notarized: false
manualDesktopAccepted: false
```

核验时该候选的 [CI run 37951834204](https://github.com/magic-alt/virtuallab/actions/runs/37951834204) 和 [RC run 37951834391](https://github.com/magic-alt/virtuallab/actions/runs/37951834391) 均成功，两者 `headSha` 均为上述完整候选 SHA。该本地 ZIP 的摘要不用于替代 CI 产物或签名后产物的摘要。

尚未验证：候选安装后的 GUI、原生确认框、真实 Agent 认证、交互式 Monaco/CSP、安装/升级/卸载、资源压力、签名与公证。未替换或中断已运行的 VirtualLab 实例；本记录不是正式发布放行。


## PR #43 合并后可靠性修复（2026-10-10）

源码基线：main@32238ffeb63556c9f35080e84054f16d4108258c。修复分支：fix/release-audit-reliability。本次不变更 0.5.0 版本，不创建 Tag 或 Release。

- Verification 使用 ManagedChild，正常退出、取消、超时及等待失败均清理并确认进程树；日志读取收尾有独立三秒期限，失败不放行。
- Verification 每个 stdout/stderr 日志最多 8 MiB；超量继续排空但不落盘，明确标记 gate fail，并保存截断日志摘要。
- Agent 原生协议/诊断流有 128 KiB 单记录输入上限；超长记录丢弃至换行，发出诊断并恢复下一条消息。
- macOS 共享原生 CLI 查找及子进程解释器 PATH，覆盖 GitHub 面板、Git 认证和各 Agent。不运行登录 shell，不缓存缺失结果。用户使用自定义版本管理器或非标准安装路径时仍应提供可用 PATH。
- manifest.json 使用独占临时文件、sync、同目录原子替换；Unix 同步父目录。增加旧 inode 不被原地修改的回归。
- 修复 Windows 已存在目录 canonicalize 的 verbatim 前缀与普通路径不一致的问题；全量测试中已有路径归一化用例曾因此失败。

验证结果将在本节记录；不得沿用上方旧候选的测试或安装包摘要作为本次证据。

仍需维护者关闭：最终修复 SHA 的三平台 CI/候选包；macOS Finder、Dock、Terminal 下真实 gh 和各 Agent 的检测/认证/启动；APFS 大小写别名；三平台安装/升级/卸载与真实 Qt/CMake/Keil 项目；签名、公证、签名后 SHA-256；main Required quality gate 保护；Issue #19/#34/#40 和最终签核。GBK/CP936、Monaco 内存/卡顿基准、PR 列表 50 项及 Run 历史不跨重启仍为已知限制。

本次 Windows 自动化结果（2026-10-10，当前修复工作树）：

| 检查 | 结果 |
| --- | --- |
| locked npm ci | 通过，184 个包，audit 0 vulnerabilities；锁文件无改动 |
| acceptance:local | 通过：typecheck、38 个前端测试文件/156 项测试、production build、85 项 Rust 测试及 doc tests |
| Windows cargo check --locked | 通过 |
| version:check | 通过，维持 0.5.0 |
| git diff --check | 通过 |
| 独立源码审查 | 无 Critical/Important；相对 PATH 边界已按失败回归修复，补充磁盘写入失败与 Windows 原子替换失败保留旧文件测试 |
| Linux cargo check / acceptance | 未执行：WSL Ubuntu-24.04 未找到 Linux Rust 工具链 |
| macOS acceptance / Finder/Dock | 未执行：当前主机为 Windows；Unix GUI CLI 解释器测试已加入，等待对应 runner |

保留现有 Monaco chunk size 警告及 MSVC 链接器库创建提示。独立审查为源码审查；不是第三方复跑测试或真实桌面签核。取消与正常退出分别有回归，精确同时发生的竞争仍需平台压力验收。

## PR #44 已合并后的 Release 审核更新（2026-10-10）

本节更新前面 PR #44 开发期间的记录，**覆盖其“等待 CI”的旧状态**，但不伪造尚未执行的实机验收。

### 基线及最终自动化

| 项目 | 真实记录 |
| --- | --- |
| PR #44 | [Merged](https://github.com/magic-alt/virtuallab/pull/44)，head `83683f2c5ef2645b757fe882a517ba248c81598d` |
| 最新合并 main | `e693f4f690d10a6439377e1466e6a828cf54e7e8` |
| [main CI](https://github.com/magic-alt/virtuallab/actions/runs/38030779241) | **6/6 成功**：Frontend Node 22/26、Windows/Linux/macOS native、Required quality gate |
| Windows 自动化 | 156 项前端 + 85 项 Rust 测试通过，release host 编译通过；**并非 NSIS 的安装后 GUI 验收** |
| macOS 自动化 | 155 项前端（另 1 项 Windows-only 跳过）+ 92 项 Rust 测试通过，.app 和图标原生解码通过 |
| Linux 自动化 | 155 项前端（另 1 项 Windows-only 跳过）+ 92 项 Rust 测试通过；未在用户 GUI 会话中运行 .deb |
| Release Candidate 工作流 | PR #44 的 [RC Run](https://github.com/magic-alt/virtuallab/actions/runs/38029907168) **SKIPPED**：仅对 release/* PR 自动构建 |
| 历史打包产物 | PR #43 的 [RC 构建](https://github.com/magic-alt/virtuallab/actions/runs/37956553562) 三平台成功，但 `sourceSha=cdfd68540da9f6921b3a73e25942456221f43099`，**不是 PR #44 合并后的 main** |
| Branch protection / Rulesets | main `protected=false`；必需 CI enforcement off；未发现 Ruleset |
| GitHub Releases | 尚未发布（当前检查时） |
| 版本 | 0.5.0，package / Tauri / Cargo / lockfiles 一致 |

### PR #44 源码复审结论

- [x] Verification 通过 ManagedChild 清理进程树；取消、超时、父进程提前退出时均尝试确认子孙退出；3 秒日志读取结束检查用于 fail closed。Unix 主动脱离进程组的 daemon **不在所有权保证范围内**。
- [x] Verification 每个 stdout/stderr 流写入最多 8 MiB，超限继续排空并返回失败；日志产物有独立哈希。
- [x] Agent app-server / Claude / OpenCode 原生协议按记录限制 128 KiB，超长记录丢弃至下一个换行，后续记录可继续解析。
- [x] macOS 共享 GUI CLI 发现：GitHub、Agent、Git credential helper；继承 PATH 及 Homebrew 常见安装路径，解决 `/usr/bin/env` 查找子解释器的问题。
- [x] `manifest.json` 通过同步临时文件和同目录原子 rename 更新；Windows UNC/verbatim 别名归一化。
- [x] 以上源码与平台相关单元测试进入 main CI。它们证明自动化用例通过，**不证明 Finder/Dock 下真实认证或安装后的 GUI 行为**。

### Stable Release 必须关闭的门禁

- [ ] 在**最终批准的 main SHA** 上，通过 `Release Candidate (unsigned QA bundles)` 的 `workflow_dispatch`（选择 main）重新构建 Windows NSIS、macOS .app ZIP 和 Linux .deb；逐一验证 manifest `sourceSha`、版本、SHA-256，不能沿用 PR #43 的旧包。
- [ ] Windows/macOS/Linux 干净账户安装、首次启动、升级/卸载、设置保存与恢复、窗口尺寸、原生确认框 Cancel、Git/PR 审核与保护操作、Run 重新附着、进程树终止、Monaco CSP 等真实桌面操作记录。
- [ ] macOS Finder、Dock、Terminal 三种入口的 `gh` / Codex / DeepSeek / Claude / OpenCode 实际安装、认证、交互和离线失败处理；Windows/Linux 相应功能；提供进程和退出码证据。
- [ ] 使用真实项目验收 Windows npm/Tauri、Keil MDK、Qt 6/CMake，macOS Qt/Tauri 与 Linux Git/CMake/Agent（跟踪 [#34](https://github.com/magic-alt/virtuallab/issues/34)）。
- [ ] GitHub main Ruleset/Branch protection 要求 `Required quality gate`、PR Review、禁止无审查绕过和强推。
- [ ] 完成最终 Windows 签名策略、macOS Developer ID 签名和公证、Linux 分发校验；签名**之后**重新生成和独立验证 SHA-256。
- [ ] 完成用户支持矩阵、Release Notes 与已知限制、维护者签核、不可变 Tag 与 GitHub Release。若采用 `v0.5.0-rc.1` 标签，必须先同步 package/Tauri/Cargo/双 Lockfile 为 `0.5.0-rc.1`。

### 已知限制 / 非主线阻断项

- GBK/CP936 中文工具输出仍无专用解码；GitHub PR 列表限 50 条。
- Run 历史进程内保存，非跨崩溃恢复；Agent journal/证据 registry 在后续 Roadmap。
- Monaco 大 chunk 警告、重负载 RSS/CPU/P95/崩溃恢复压力尚未实测；macOS 大小写不敏感 APFS 路径别名与脱离 PGID 子进程的收尾仍需真实平台资格化。
- 软件审批和硬件物理安全联锁是不同边界，软件 UI 不能代替硬件安全机制。

**当前裁决：受控内部 QA/RC 可以开展；正式公开稳定 `v0.5.0` 为 NO-GO。** 参见 [Issue #40](https://github.com/magic-alt/virtuallab/issues/40)。本次不创建发布 Tag 或 GitHub Release，不声称签名和人工实机验收已完成。
