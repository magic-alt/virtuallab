# Task-driven Workbench：流程模板与真实 Agent 案例

## 入口与运行

在桌面版的任务工作台「控制中心」或「任务」页打开「流程模板库」。原有「新建任务」仍打开手动计划编辑器；多节点计划与依赖图没有改变。

第一次体验选择「预览并运行案例」。选择已经添加、具有提交的本地 Git 仓库，点击「读取模板基线」，检查任务合同和验证配置。案例要求 Node.js 22+ 在桌面应用可解析的 PATH 中，并且原生任务 Agent 已安装且认证可用。保存过会话或 CLI 可执行并不证明认证有效。

逐项确认「允许 Native 检查范围后封存本地提交」和「创建独立 Worktree 并启动真实 Agent」，然后点击「确认并运行模板」。这一个用户操作依次调用已有的 `task_accept_plan`、`task_prepare_workspace`、`task_start`，不会自动推送或合并。也可以只保存计划，后续在详情中手动准备和执行。

打开任务详情观察实际 Attempt、检查和错误。Native 独立验证后，仍需检查变更、完成人工审查与验收。没有本地桌面环境时可以浏览模板，但运行按钮禁用，没有模拟任务结果。

## 内置案例做什么

案例要求 Agent 在独立 Worktree 的唯一目录 `virtuallab-examples/task-ranking-<UUID>/` 内编写一个稳定排序函数。未完成任务排在已完成任务前，同组按 high、normal、low 排序，同优先级保持原顺序；验证输入、拒绝重复 ID、保留额外字段、不修改输入。

Agent 需要产出 `rank-tasks.mjs`、`rank-tasks.test.mjs`、`acceptance.mjs`、`demo.mjs`、`SPEC.md`、`PLAN.md` 和 `REVIEW.md`。模板提供需求和验收参考源码，不提供功能实现或预制成功报告。

Profile 配置三个真实进程检查：`node --test <目录>/rank-tasks.test.mjs`、`node <目录>/acceptance.mjs`、`node <目录>/demo.mjs`。无需 npm install、服务器、API Key 文件或第三方包。案例命令行输出是验证产物，不新增可执行 HTML 预览。

**验收边界：** 参考源码保存在任务合同里；`acceptance.mjs` 由 Agent 写入工作区，仍是可修改源码。人工审查必须与合同核对，防止删除断言。冻结 Profile 只固定命令配置，不会让测试文件不可篡改。Native 将实际输入、工具链、Run 和候选提交绑定；进程退出 0 不是完整规格或安全性的证明。这里不是独立 AI Reviewer 或不可伪造的测试证明。

## 分层与 Superpowers 的对应关系

`templates/catalog.ts` 是带版本的模板目录和可组合方法集合，按触发条件组织目标澄清、根因调查、规划、TDD、自查、证据交接。`materializeTemplate` 将它们变成现有 TaskDraft；Profile 复制为快照，不修改已有 Profile。模板标识在 goal 中只用于展示，不授予资格。

`templates/launch.ts` 是一次明确用户操作的协调器，不是新调度器。它使用 typed ports 调用已有 Native API，按顺序等待结果，返回不确定时停止，不重放。真正的排队、取消、持久化、范围校验、证据和恢复继续由现有 Native 负责。

`templates/stages.ts` 只把 TaskRecord 和 TaskReadiness 投影为目标与计划、隔离工作区、任务执行、独立验证、人工审查、交付验收六个导航阶段。不会凭 Agent 文字报告标记 TDD/设计已完成，也不会让过期证据授予交付资格。

这是对 Superpowers 可组合工程方法的借鉴，不是复制或安装 Superpowers 插件。没有声称支持其所有宿主 Hook、多 Agent 自动派发或只读 AI Reviewer。简单模板是一项原生任务；已有手动 DAG 编辑器继续处理多任务方案。

## 不改变的边界

不修改 Rust 后端、原生执行白名单、Tauri 权限、任务存储 schema、仓库管理、分支切换、终端、Changes、GitHub 工程页、Agent Provider、依赖或锁文件。已有的 TaskDetail、TaskPlanWizard 与 Profile 设置保留。

运行时不会写入原工作区的业务文件，也不会复制未提交修改。Worktree 与原仓库共享 Git 元数据，不是 OS 沙箱；安全权限仍以宿主为准。模板不改变 Agent 权限。业务工程有不受控安装脚本或不可信指令时，仍应使用专门的安全测试仓库。

原生规则禁止 `node --eval`、内联脚本和带控制字符的 argv，因此本实现采用显式脚本文件，不放宽权限。模板没有自动重试、自动合并或自动验收。启动中关闭页面、移除仓库或后端返回不确定结果后，已保存的记录保留，应在任务详情核对并显式恢复。

## 验证

运行 `node scripts/check-task-templates.mjs` 检查模板合同、真实 Node 验收参考、错误实现的反例，以及启动/失败/上下文失效逻辑。它不是全项目构建或桌面验收的替代。

运行 `npm test -- src/features/tasks/templates` 执行 Vitest 合同与交互测试；同时保留 `npm run typecheck`、`npm test`、`npm run build` 和项目原有桌面验收。完整 CI 配置未改。

人工验收至少覆盖：没有 Agent 认证时失败可见；启动一次后不会重复创建；实际 AI 可以完成案例并产生真实 Run；弱化验收脚本不能被人工批准；仓库页面、Worktree 切换和 Changes 行为保持不变。AI 的能力、认证和执行结果不能通过本实现的单元测试替代验证。
