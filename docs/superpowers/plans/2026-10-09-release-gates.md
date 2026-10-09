# v0.5.0 Release Gate 修复计划

用户提供的 2026-10-09 发布审查和“请按照方案进行修复”为本次实施依据。原地修复，不创建 Release 或标签。后续用户授权补齐 Unix PTY 清理、测试通过后提交 Git 和 PR。

- [x] 统一原生确认，取消或失败不得执行；保留 PR 后端 HEAD/CI 校验。
- [x] Native Run Registry 按规范路径隔离，原子预留 ID/运行槽，保留有界输出和终态；前端重新附着，Stop 请求与退出分离。
- [x] 非交互 Process / Build / Agent 共享进程树终止策略；退出后再报告停止；应用退出清理。
- [x] Terminal 启动与注册互斥，失败回收；Codex 同工作区启动互斥；复用 Windows launcher 解析。
- [x] Unix 交互 PTY 跨作业进程组清理，真实 PTY 回归覆盖忽略 HUP/TERM、其他会话隔离、shell 先退出及 WNOWAIT 监测。
- [ ] 三平台真实终端压力与 GUI 验收。
- [x] Watcher 在调用入口预留代次，停止使旧启动失效，过期 watcher 在锁外释放。
- [x] 配置本地 Monaco worker 所需 CSP；补充发布门禁记录。
- [x] 回归测试、locked 安装、前端类型检查与构建、Windows Rust / acceptance 验证；Linux/macOS GUI、签名安装与升级保留为未完成验收。

约束：结构化参数，无新增任意 shell API，不读取或输出凭据/环境变量内容，不绑定特定工程或硬件。架构变更同步 docs/ARCHITECTURE.md。

尚未关闭的门禁：候选 SHA 三平台 CI 与三平台 GUI、签名安装升级验收；详见 docs/RELEASE_GATE_V0.5.0.md。以上勾选表示源码实施和本机自动化完成，不代表正式发布放行。
