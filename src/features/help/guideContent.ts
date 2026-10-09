/**
 * Bundled, repository-neutral documentation.
 * Keep operational examples in sync with docs/USER_GUIDE.md and the actual UI.
 * No network request, Markdown runtime or remote image dependency is required.
 */
export type GuideBlock =
  | { type: "text"; text: string }
  | { type: "steps"; items: { title: string; description: string }[] }
  | { type: "callout"; tone: "note" | "warning"; title: string; text: string }
  | { type: "code"; label: string; language: string; content: string }
  | { type: "diagram"; src: string; alt: string; caption: string }
  | { type: "cards"; items: { title: string; description: string }[] }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "checklist"; items: string[] };

export type GuideCategory = "从这里开始" | "核心工作流" | "扩展与参考";

export interface GuideSection {
  id: string;
  title: string;
  blocks: GuideBlock[];
}

export interface GuidePage {
  id: string;
  category: GuideCategory;
  icon: "start" | "layout" | "branch" | "review" | "build" | "terminal" |
    "github" | "agents" | "shield" | "examples" | "help" | "architecture";
  title: string;
  subtitle: string;
  duration: string;
  sections: GuideSection[];
}

export const guideCategories: GuideCategory[] = [
  "从这里开始", "核心工作流", "扩展与参考",
];

export const guidePages: GuidePage[] = [
  {
    id: "start", category: "从这里开始", icon: "start", title: "快速入门",
    subtitle: "从安装到第一次执行构建，认识 VirtualLab 的本地工程工作流。",
    duration: "约 5 分钟",
    sections: [
      { id: "what", title: "VirtualLab 是什么？", blocks: [
        { type: "text", text: "VirtualLab 是本地优先的工程工作台：将 Git 仓库、独立 Worktree、终端、构建任务、代码审阅和可选的 Coding Agent 放在同一工作区中。它不要求项目使用特定的 MCU、SDK 或硬件平台。" },
        { type: "diagram", src: "/help/workbench-map.svg", alt: "VirtualLab 程序示意图：左侧为仓库和 Worktree，中部为 Overview、Changes、Run 等选项卡", caption: "图 1 · 工作台布局示意，非实时截图；界面标签以安装版本为准。" },
        { type: "cards", items: [
          { title: "Repository / 仓库", description: "已存在的本地 Git 项目。VirtualLab 读取并显示状态，不代替 Git 项目本身。" },
          { title: "Workspace / 工作区", description: "绑定某一个 Git worktree 目录，执行、审阅和 Agent 上下文均归属这个目录。" },
          { title: "Local-first / 本地优先", description: "仓库和差异浏览不要求登录 GitHub；联网协作与 Agent 均为可选项。" },
        ] },
      ] },
      { id: "install", title: "安装与启动开发版本", blocks: [
        { type: "text", text: "从源码运行要求 Node.js 22.12+、npm、Rust stable、Git，以及操作系统对应的 Tauri 原生构建依赖。Windows 需 C++ Build Tools / Windows SDK / WebView2；macOS 需 Xcode Command Line Tools；Linux 需 WebKitGTK 4.1 等开发包。" },
        { type: "code", label: "克隆与运行桌面版", language: "bash", content: "git clone https://github.com/magic-alt/virtuallab.git\ncd virtuallab\nnpm ci\nnpm run doctor\nnpm run tauri:dev" },
        { type: "callout", tone: "warning", title: "Web preview 不是桌面运行时", text: "npm run dev 只启动前端演示。Add repository、实际 Git 操作、PTY 终端及构建必须使用 Tauri 桌面版；离线使用指南在两种模式下都能查看。" },
      ] },
      { id: "first", title: "第一次使用：四个动作", blocks: [
        { type: "steps", items: [
          { title: "导入本地仓库", description: "点击左侧 Add repository，选择已经初始化 Git 的项目根目录。" },
          { title: "确认工作区", description: "检查顶部仓库名、当前分支、工作树状态；左栏显示 Workspace lanes 和 Git branches。" },
          { title: "运行项目构建", description: "进入 Run；如检测到 npm、CMake/Qt 或 Keil 配方，选择对应 one-click build。否则添加自定义 Build profile。" },
          { title: "查看结果", description: "Run 显示执行步骤、stdout/stderr 与最终状态。切换 Changes 检查修改的文件。" },
        ] },
        { type: "checklist", items: ["本机 git --version 可运行", "使用桌面版而非浏览器预览", "构建工具已安装并可从 PATH 或绝对路径访问", "仓库来源与构建脚本可信"] },
      ] },
    ],
  },
  {
    id: "layout", category: "从这里开始", icon: "layout", title: "认识工作台",
    subtitle: "导航、仓库栏、主工作区和状态栏分别承担什么职责。",
    duration: "约 4 分钟",
    sections: [
      { id: "panels", title: "五个区域", blocks: [
        { type: "diagram", src: "/help/workbench-map.svg", alt: "标注 VirtualLab 顶部栏、左侧仓库栏、工作区状态头部、标签栏和主视图区的界面示意图", caption: "图 2 · 概念化的界面分区。Help → 使用文档不依赖已经导入仓库。" },
        { type: "table", columns: ["区域", "看到什么", "常见操作"], rows: [
          ["顶部菜单栏", "VirtualLab、Help → 使用文档、搜索框、Native/Web preview", "从应用菜单打开离线手册，不切换工作区"],
          ["左侧栏", "Local repositories、Workspace lanes、Git branches", "导入项目、切换 worktree / 分支"],
          ["工作区头部", "仓库、当前分支、远端、HEAD、洁净状态", "Fetch + prune、Pull、Refresh"],
          ["功能标签", "Overview / Changes / GitHub / Agents / Terminal / Run / Checks / History", "在同一工作区切换任务（不包含文档入口）"],
          ["底部状态栏", "本地执行边界与应用版本", "确认安装版本"],
        ] },
      ] },
      { id: "tabs", title: "如何选择功能标签", blocks: [
        { type: "cards", items: [
          { title: "Overview + History", description: "查看工作区拓扑、最近提交和本地状态。" },
          { title: "Changes + GitHub", description: "审阅代码差异，追踪 PR/Issue 上下文；推送评论需单独确认。" },
          { title: "Terminal + Run", description: "交互式 Shell 与结构化可重复构建分别管理，避免混用。" },
          { title: "Checks + Agents", description: "本地 readiness 检查；按需附加 Coding Agent。" },
        ] },
        { type: "callout", tone: "note", title: "所有工作区共用这本手册", text: "从顶部 Help → 使用文档打开独立阅读界面，不属于工作区标签；关闭后回到原工作区和标签。打开文档不会切换 Git 分支、运行命令、上传代码或更改当前项目。" },
      ] },
    ],
  },
  {
    id: "worktree", category: "核心工作流", icon: "branch", title: "Git 分支与 Worktree",
    subtitle: "并行开发不覆盖彼此的修改，理解分支切换和远端删除的边界。",
    duration: "约 6 分钟",
    sections: [
      { id: "flow", title: "Repository → Worktree → Task", blocks: [
        { type: "diagram", src: "/help/worktree-flow.svg", alt: "一个 Git 仓库主分支连接两个独立 Worktree 的分支拓扑示意图", caption: "图 3 · 两条独立工作线共享 Git 历史，但各自拥有工作目录。" },
        { type: "text", text: "一个仓库可以有多个 Worktree。每条工作线的文件、编译输出和终端工作目录相互独立；但同一个本地分支不能同时在两个 Worktree 检出。" },
      ] },
      { id: "create", title: "创建隔离工作区", blocks: [
        { type: "steps", items: [
          { title: "选择 Repository", description: "左侧点击目标仓库，先确定当前 HEAD 是希望基于的提交。" },
          { title: "点击 Workspace lanes → New", description: "输入新分支名，确认 Base ref 与目标目录。" },
          { title: "创建并进入", description: "VirtualLab 通过原生 Git 创建 worktree，切换到新目录；Overview 会显示工作线。" },
          { title: "回到已有工作区", description: "点击 Workspace lanes 中的另一条工作线，无需删掉当前分支。" },
        ] },
        { type: "code", label: "理解底层 Git 行为（命令行示例）", language: "bash", content: "git worktree add ../my-project-feature -b feat/drive main\ngit worktree list\ngit status --short" },
        { type: "callout", tone: "warning", title: "删除 Worktree 不等于强制清理文件", text: "应用仅允许确认后移除洁净的非主 Worktree；有未提交修改时 Git 会拒绝。不要把删除工作区当成备份方式。" },
      ] },
      { id: "remote", title: "切换与管理本地 / origin 分支", blocks: [
        { type: "text", text: "侧边栏把当前分支和 main 优先显示。点击分支：若已由另一 Worktree 占用，会打开对应工作区，而不是强行重复检出。Fetch + prune 仅同步远端引用并清理已消失的 remote-tracking refs；Pull 仅进行快进更新。" },
        { type: "table", columns: ["动作", "影响范围", "注意"], rows: [
          ["Switch", "当前 worktree 中的本地分支", "未跟踪文件冲突或脏状态可能阻止切换"],
          ["Delete local", "本地已合并且未占用的分支", "保护 main/master 和占用中的分支，需确认"],
          ["Delete origin", "远端 origin 分支", "独立确认，不自动删除本地分支；保护默认分支"],
          ["Fetch + prune", "本地的远端跟踪信息", "不会自动合并工作文件"],
        ] },
      ] },
    ],
  },
  {
    id: "review", category: "核心工作流", icon: "review", title: "Changes 与代码审阅",
    subtitle: "理解三种 Diff 模式，正确处理行评论与复审。",
    duration: "约 6 分钟",
    sections: [
      { id: "modes", title: "三种差异视图", blocks: [
        { type: "table", columns: ["模式", "比较对象", "适用场景"], rows: [
          ["Worktree", "工作目录中尚未暂存的修改", "日常迭代、自查"],
          ["Staged", "索引（暂存区）中的修改", "提交前核查"],
          ["Base", "当前提交与选定 Base ref 的差异", "分支对比与 PR 审阅"],
        ] },
        { type: "text", text: "Changed 文件由原生 Git 读取，Monaco 编辑器提供 Unified（上下）与 Side by side（左右）只读差异视图。文件选择、工作树和基线变化需要及时刷新；二进制或过大的文件可能只有状态提示。" },
        { type: "callout", tone: "note", title: "未跟踪文件 ≠ 完整 Diff", text: "未跟踪文件和目录会显示路径与状态，但不会被当作 Git 已跟踪文件调用差异预览，也不能据此创建行评论。" },
      ] },
      { id: "review-loop", title: "评审闭环：Review → Fix → Re-review", blocks: [
        { type: "steps", items: [
          { title: "选择目标文件", description: "在 Changes 中选取已跟踪文件，切换 Unified 或 Side by side 检查变更。" },
          { title: "记录评论草稿", description: "选定行并编写本地 draft。此操作仅存储在本机，不会立即发给 GitHub。" },
          { title: "修改与刷新", description: "在外部编辑器或终端修复后，使用 Refresh and re-review，加载新的 Diff。" },
          { title: "确认新的 HEAD", description: "之前 HEAD 上的评论可能变 stale。重新检查后标记 reviewed；需要时再单独确认发布。" },
        ] },
        { type: "callout", tone: "warning", title: "避免评论指向旧版本", text: "发布到 GitHub 时须满足同仓库、当前本地 HEAD 与 PR HEAD 匹配等条件，且需要显式确认。VirtualLab 不会替你自动执行 merge。" },
      ] },
    ],
  },
  {
    id: "build", category: "核心工作流", icon: "build", title: "一键构建与 Run",
    subtitle: "npm、Qt/CMake、Keil 及自定义多步骤 Build/Test/Package/Deploy 工作流。",
    duration: "约 8 分钟",
    sections: [
      { id: "buildmap", title: "从探测到执行", blocks: [
        { type: "diagram", src: "/help/build-pipeline.svg", alt: "VirtualLab 自动发现 npm、CMake Qt、Keil 构建建议，进入顺序执行和日志输出的工作流图", caption: "图 4 · 构建流程。检测只读取当前 worktree 的项目文件，真正执行始终由用户发起。" },
        { type: "text", text: "Run 根据当前工作区内的 package.json 脚本、CMakeLists.txt（包括 Qt 项目）或受限范围内的 Keil *.uvprojx 提示 one-click build。检测并不安装工具链；运行前要确保编译器、Qt SDK 或 Keil MDK 已配置。" },
        { type: "steps", items: [
          { title: "进入 Run", description: "打开 One-click project builds，检查自动探测出的 Build / Package 建议。" },
          { title: "确认配方", description: "选择 Build now / Package now，或将建议保存为可修改的 repository-scoped profile。" },
          { title: "查看步骤", description: "多步骤顺序执行。任何一步失败会停止后续步骤，并显示 stdout/stderr、退出状态。" },
          { title: "必要时 Stop", description: "Stop 向软件进程树发出尽力而为的取消请求；这不是硬件紧急停机。" },
        ] },
      ] },
      { id: "npm", title: "案例 A：前端 npm 构建", blocks: [
        { type: "code", label: "在 Terminal 中检查 npm 项目", language: "bash", content: "node --version\nnpm ci\nnpm run build" },
        { type: "text", text: "如果 package.json 提供 build 脚本，Run 的 one-click builds 可展示 npm 相关建议。输出为项目构建日志，是否成功由具体进程退出码决定，不代表软件已部署。" },
      ] },
      { id: "cmake", title: "案例 B：Qt / CMake 工程", blocks: [
        { type: "code", label: "两步 Qt/CMake profile（示例）", language: "text", content: "Step 1 · Configure\n  program: cmake\n  args: -S . -B build -DCMAKE_BUILD_TYPE=Release\nStep 2 · Compile\n  program: cmake\n  args: --build build --config Release" },
        { type: "text", text: "请在已安装 Qt、CMake 和目标编译器的机器上运行。必要时由用户指定 CMAKE_PREFIX_PATH、工具链文件或生成器；Windows MSVC、MinGW 与 macOS 路径不可照搬。profile 将两个步骤的 program 与 args 分别存储，而非拼接一个 Shell 字符串。" },
        { type: "callout", tone: "note", title: "跨平台建议", text: "先在 Terminal 手动验证 configure/compile 命令，再放入 Run 的 Build Profile。自定义 profile 绑定仓库、在当前 Worktree cwd 执行，本地保存，不会自动提交到 Git。" },
      ] },
      { id: "keil", title: "案例 C：Keil MDK 固件", blocks: [
        { type: "code", label: "Windows Keil 命令组成（示例）", language: "text", content: "program: C:\\Keil_v5\\UV4\\UV4.exe\nargs: -b Firmware.uvprojx -j0" },
        { type: "text", text: "Keil 建议只适用于已安装对应 MDK 工具链的 Windows 主机。工程名称、UV4 路径和 target 需以实际 .uvprojx 为准。构建配方不自动执行烧录、上电或电机使能。" },
      ] },
      { id: "limits", title: "Package 与 Deploy 的区别", blocks: [
        { type: "callout", tone: "warning", title: "部署始终是显式动作", text: "Package 只生成安装包或产物，不等于发布或安装。Deploy 仅能由用户编写并每次手动确认；外部脚本仍可能修改系统，因此只执行可信项目与脚本。" },
        { type: "checklist", items: ["工作区路径与目标分支正确", "工具链本机可用、目标平台一致", "步骤参数已检查，无意外的烧录或发布操作", "日志中有最终结束状态，不把 exit=0 当作硬件验证证明"] },
      ] },
    ],
  },
  {
    id: "terminal", category: "核心工作流", icon: "terminal", title: "Terminal、Checks 与 History",
    subtitle: "交互式命令、结构化执行和本地仓库检查各有适用边界。",
    duration: "约 4 分钟",
    sections: [
      { id: "pty", title: "Terminal 和 Run 的区别", blocks: [
        { type: "cards", items: [
          { title: "Terminal = 交互式 PTY", description: "适合人工执行 Git、命令行调试及需要输入的工具，支持交互、窗口尺寸变化和 Ctrl+C。" },
          { title: "Run = 可重复的步骤", description: "适合编译、单测、打包及确认过的部署命令，使用 program + args + cwd 结构化启动。" },
          { title: "Checks = 本地状态汇总", description: "展示已定义的仓库 readiness 状态；不等于完整的生产线签核。" },
        ] },
        { type: "code", label: "常见工作区检查", language: "bash", content: "git status --short\ngit branch --show-current\ngit log -5 --oneline" },
      ] },
      { id: "history", title: "History / Overview", blocks: [
        { type: "text", text: "Overview 显示工作树是否洁净、活动分支、Worktree 数量和最近提交。History 专门列出近期提交。它们是帮助你确定工作上下文的视图，不会自动修改仓库。" },
        { type: "callout", tone: "note", title: "运行结果的保留限制", text: "Run 的屏幕日志和部分会话状态为本次应用会话内数据；切换视图后不要依赖其作为长期证据。需要可追溯归档时，应使用独立的验证/证据存储流程。" },
      ] },
    ],
  },
  {
    id: "github", category: "核心工作流", icon: "github", title: "GitHub 与 PR 协作",
    subtitle: "把 PR/Issue 与本地 worktree 关联，不自动接管远端代码。",
    duration: "约 6 分钟",
    sections: [
      { id: "connect", title: "准备 GitHub CLI", blocks: [
        { type: "code", label: "检查 gh 登录状态", language: "bash", content: "gh --version\ngh auth login\ngh auth status" },
        { type: "text", text: "GitHub 功能为可选项。VirtualLab 复用本机 gh CLI 的认证状态，并依据仓库 origin 判断 GitHub 仓库。没有 gh、未授权、非 GitHub origin 或离线时，Changes 及本地工作区仍然可用。" },
      ] },
      { id: "pr", title: "从 Issue / PR 开始评审", blocks: [
        { type: "steps", items: [
          { title: "切换到 GitHub 标签", description: "加载对应仓库的 PR、Issue 与 checks 元数据。" },
          { title: "选择记录", description: "从 PR 或 Issue 打开预填的 New workspace 对话框。" },
          { title: "检查 Base 与分支名", description: "应用不会自动检出远端 PR head。由用户明确创建本地独立工作树。" },
          { title: "本地 Review → Fix → Re-review", description: "在 Changes 保存评论草稿，并于修改后重新加载差异。" },
          { title: "单独发布评论", description: "在 HEAD 与 PR head 等校验通过后，选择评论并确认 GitHub 写操作。" },
        ] },
        { type: "callout", tone: "warning", title: "关联 PR 不等于检出 PR", text: "PR/Issue 是上下文引用；创建 worktree 的基线默认取当前选中工作区的 HEAD。不要认为界面中显示了 PR 就已拉取其代码。" },
      ] },
    ],
  },
  {
    id: "agents", category: "扩展与参考", icon: "agents", title: "Coding Agents",
    subtitle: "按需接入 Codex、DeepSeek、Claude Code、OpenCode；将审查权留在工作区。",
    duration: "约 7 分钟",
    sections: [
      { id: "model", title: "Agent 是适配器，不是工程状态的所有者", blocks: [
        { type: "diagram", src: "/help/agent-safety.svg", alt: "工作区连接可选 Agent、命令执行与独立硬件保护边界的示意图", caption: "图 5 · Agent 工作线与安全边界。保护确认不等于设备授权。" },
        { type: "text", text: "Agents 页可以检测 provider 可用性，Attach / resume 已配置的 harness，提交 turn、观察事件时间线并手动中断。Provider 需要用户自行安装与配置，不随 VirtualLab 自动下载或认证。" },
        { type: "table", columns: ["Harness", "连接模式", "现阶段说明"], rows: [
          ["Codex", "App-server JSON-RPC", "按工作区关联 thread / turn"],
          ["DeepSeek", "通过 Codex + DeepSeek Responses API", "需额外配置 API，沿用 Codex 通信机制"],
          ["Claude Code", "CLI plan/read-only", "能力由安装版本决定，不假定有写权限"],
          ["OpenCode", "CLI plan/read-only", "能力由安装版本决定，不假定有写权限"],
        ] },
      ] },
      { id: "configure", title: "附加一个 Agent", blocks: [
        { type: "steps", items: [
          { title: "配置外部工具", description: "先安装并完成对应 CLI/API 环境设置；不要把密钥写入角色或项目文件。" },
          { title: "Check availability", description: "在 Agents 选择 Harness，确认 provider 已检测到且可用。" },
          { title: "Attach / resume", description: "将当前 worktree 关联到 provider 线程，同一工作区同一时刻只附加一个运行时。" },
          { title: "选择 Role / Skills", description: "使用通用或自定义角色；技能是可选的本地指令，不是自动提升权限。" },
          { title: "发起并检查结果", description: "输入任务 Start turn，查看 structured event timeline，必要时 Interrupt 或 Stop runtime。" },
        ] },
      ] },
      { id: "safety", title: "代理执行限制", blocks: [
        { type: "callout", tone: "warning", title: "请勿依赖软件确认进行设备动作", text: "当前没有随包提供的硬件 backend。Protected operations 中的人类 acknowledgement 只记录软件决策，无法启用 motion/power/flash/release。真正的设备操作必须由外部独立硬件授权和联锁机制强制约束。" },
        { type: "text", text: "CLI provider 权限模式也不等于操作系统级沙箱。仅对可信仓库启用可执行工作流，审查 Agent 提议的修改，不要将秘密写入 prompt、log 或截图。" },
      ] },
    ],
  },
  {
    id: "safety", category: "扩展与参考", icon: "shield", title: "验证、证据与安全",
    subtitle: "正确理解本地 readiness、底层证据接口与硬件保护缺口。",
    duration: "约 5 分钟",
    sections: [
      { id: "levels", title: "三种不同的“通过”", blocks: [
        { type: "cards", items: [
          { title: "Run passed", description: "构建或脚本执行结束且退出码符合预期；不代表产物正确或已测试真机。" },
          { title: "Checks passed", description: "定义好的本地 readiness 条件满足；不等同于完整质量认证。" },
          { title: "Verification evidence", description: "原生受限执行器可以存储 profile、manifest、stdout/stderr 与 SHA-256 哈希，需使用对应的验证调用方。" },
        ] },
        { type: "callout", tone: "note", title: "不要误认为已具备全自动 HIL", text: "底层 verification_run 支持受限的 build/unit/evidence 进程门；HIL、soak 和硬件门目前 BLOCKED。界面中的 Run/Checks 并不是硬件 HIL 运行面板。" },
      ] },
      { id: "evidence", title: "证据存储目录", blocks: [
        { type: "code", label: "原生 Verification evidence 目录结构", language: "text", content: "<workspace>/.virtuallab/evidence/<run-id>/\n  profile.json\n  manifest.json\n  <gate-id>.stdout.log\n  <gate-id>.stderr.log\n  import-N-<filename>     # optional" },
        { type: "text", text: "该证据存储由受限原生验证接口负责，不会由普通 Run 自动生成。记录包括 Git HEAD、测试结果、文件大小和哈希；仍不代表不可篡改、已签名或满足安全等级认证。" },
      ] },
      { id: "boundary", title: "任何硬件动作都应独立联锁", blocks: [
        { type: "checklist", items: [
          "硬件提供方独立执行资源锁、授权和到期处理",
          "电源、运动、烧录和发布须由人类明确批准",
          "真实设备有独立 watchdog、急停与安全状态恢复",
          "软件 Stop/Cancel 不当作安全停机链的一环",
        ] },
      ] },
    ],
  },
  {
    id: "examples", category: "扩展与参考", icon: "examples", title: "端到端实践案例",
    subtitle: "用真实可复现的步骤串起仓库、分支、审阅和构建。",
    duration: "约 9 分钟",
    sections: [
      { id: "case1", title: "案例 1 · 两个功能分支并行修复", blocks: [
        { type: "steps", items: [
          { title: "导入一个 Git 项目", description: "使用 Add repository 打开现有仓库，确认 main 无未提交变更。" },
          { title: "创建 feat/ui-contrast 工作区", description: "在 New workspace 中以 main 为 Base，输入工作区位置。" },
          { title: "创建 fix/process-timeout 工作区", description: "返回主工作区，再以 main 为 Base 创建第二条工作线。" },
          { title: "分别执行验证", description: "在每个 worktree 的 Run 执行适当的 Build/Test，Changes 分别显示其差异。" },
          { title: "逐一复审", description: "确认两个功能分支的 HEAD 和代码。Git merge/rebase 仍由开发者按项目规范完成。" },
        ] },
        { type: "diagram", src: "/help/worktree-flow.svg", alt: "主仓库派生两条独立工作线的图解", caption: "案例 1 · 同一 Git 仓库里的不同 worktree 路径互不覆盖。" },
      ] },
      { id: "case2", title: "案例 2 · 第三方 Qt 工程交付前编译", blocks: [
        { type: "steps", items: [
          { title: "确认环境", description: "安装 Qt、CMake、目标编译器，并在终端执行 cmake --version。" },
          { title: "导入 Qt 项目", description: "Add repository 后进入 Run；选择系统检测到的 CMake/Qt 配方或自定义两个步骤。" },
          { title: "Configure → Compile", description: "先 cmake -S . -B build，再 cmake --build build --config Release。" },
          { title: "确认输出", description: "检查失败步骤、构建产物和目标工具链。只有人工核验后才进一步打包或交付。" },
        ] },
        { type: "code", label: "Qt/CMake 验证命令", language: "bash", content: "cmake --version\ncmake -S . -B build -DCMAKE_BUILD_TYPE=Release\ncmake --build build --config Release" },
      ] },
      { id: "case3", title: "案例 3 · PR 代码审查并回传意见", blocks: [
        { type: "steps", items: [
          { title: "确认 gh 已认证", description: "在终端运行 gh auth status，并保证 origin 是预期的 GitHub 仓库。" },
          { title: "在 GitHub 中选择 PR", description: "记录 PR 信息并显式创建 review worktree；如需 PR head，在外部 Git 操作中自主获取。" },
          { title: "对齐本地 HEAD", description: "使用 Changes / Base 查看真实差异，写下本地逐行评论草稿。" },
          { title: "Refresh and re-review", description: "修改后重新载入差异，确认旧草稿是否 stale。" },
          { title: "人工确认发布", description: "只有同仓库、PR head 校验通过时才选择确认发布评论；不进行自动 merge。" },
        ] },
        { type: "callout", tone: "warning", title: "无静默 GitHub 写入", text: "读取 PR 信息不应触发 checkout、push 或评论发布。确认前检查仓库、分支、差异和评论内容。" },
      ] },
    ],
  },
  {
    id: "faq", category: "扩展与参考", icon: "help", title: "常见问题与排障",
    subtitle: "找不到构建工具、Git 切换失败、无法认证或看不到终端输出时怎么检查。",
    duration: "约 6 分钟",
    sections: [
      { id: "environment", title: "环境与构建", blocks: [
        { type: "table", columns: ["现象", "排查路径"], rows: [
          ["Add repository 不可点击", "是否处于 Web preview？应使用 npm run tauri:dev 或安装后的桌面程序。"],
          ["Run 无自动建议", "确认当前 Worktree 有 package.json、CMakeLists.txt 或 *.uvprojx；可添加自定义 Profile。"],
          ["npm / cmake 未找到", "在同一操作系统用户下执行 node --version、cmake --version；确认 PATH 与项目依赖。"],
          ["Keil 不能编译", "确认 Windows / MDK 已安装，UV4.exe 路径与工程名称、编译目标、环境正确。"],
          ["Qt 构建失败", "检查 CMAKE_PREFIX_PATH、生成器、MSVC/MinGW 一致性及 target 平台。"],
        ] },
      ] },
      { id: "git", title: "分支与协作", blocks: [
        { type: "table", columns: ["现象", "原因与处理"], rows: [
          ["分支切不过去", "检查是否被另一 worktree 占用，或未跟踪文件可能被覆盖。先检查 git status。"],
          ["删除分支按钮禁用", "当前分支、main/master、被其他 worktree 使用的分支受保护；删除仍需确认。"],
          ["远端分支仍显示", "Fetch + prune 更新远端跟踪信息；删除 origin 分支与删除本地分支是两个动作。"],
          ["GitHub 数据不可用", "检查 gh --version、gh auth status、origin URL 与网络；本地 Changes 不受影响。"],
          ["Review draft 显示 stale", "HEAD 已变化；重新加载 Diff 并确认草稿是否仍然适用。"],
        ] },
      ] },
      { id: "logs", title: "诊断清单", blocks: [
        { type: "code", label: "先收集非敏感诊断信息", language: "bash", content: "git status --short\ngit worktree list\ngit remote -v\nnode --version\nnpm run doctor" },
        { type: "callout", tone: "warning", title: "提交问题前保护隐私", text: "请删除日志中的 token、绝对私人目录、密钥、客户代码与设备序列号。描述系统版本、最小复现步骤、预期/实际行为、无敏感信息的错误摘要。" },
      ] },
    ],
  },
  {
    id: "architecture", category: "扩展与参考", icon: "architecture", title: "系统架构与扩展",
    subtitle: "面向开发者：React、Tauri、typed native commands 与仓库中立设计。",
    duration: "约 7 分钟",
    sections: [
      { id: "layers", title: "架构分层", blocks: [
        { type: "diagram", src: "/help/agent-safety.svg", alt: "React 工作区、Agent/工具执行和独立硬件边界的系统分层示意图", caption: "图 6 · 用户操作由前端发起，原生边界负责执行；硬件安全权不在 UI 内。" },
        { type: "table", columns: ["目录", "职责"], rows: [
          ["src/features", "React 工作台、Run、Review、GitHub、Agents 和 Guide"],
          ["src/stores + src/types", "Zustand 本地状态及跨层共享类型"],
          ["src/lib", "前端服务、校验和类型化 native 调用封装"],
          ["src-tauri/src", "Rust Git/PTY/process/build/verification 等原生服务"],
          ["docs + scripts", "设计说明、运行环境、验收和自动化脚本"],
        ] },
      ] },
      { id: "dev", title: "参与开发的最小 Gate", blocks: [
        { type: "code", label: "源码检查", language: "bash", content: "npm ci\nnpm run typecheck\nnpm test\nnpm run build\ncargo test --locked --manifest-path src-tauri/Cargo.toml" },
        { type: "text", text: "变更 native 边界时使用 Rust typed command 并补充单测。不要让文档系统执行任意 Shell、注入远端 HTML 或绑定第三方业务仓库。内置 Guide 的图、文案和组件均随应用一起打包，因此离线可读。" },
        { type: "callout", tone: "note", title: "文档维护约定", text: "功能变化时同步更新本帮助中心、docs/USER_GUIDE.md、必要的专题文档以及对应测试。图片采用本地 SVG；图形是示意而非伪装成实机截图。" },
      ] },
    ],
  },
];

export function searchGuidePages(query: string): GuidePage[] {
  const keyword = query.trim().toLocaleLowerCase();
  if (!keyword) return guidePages;
  return guidePages.filter((page) =>
    [page.title, page.subtitle, page.category, ...page.sections.flatMap((section) => [
      section.title, JSON.stringify(section.blocks),
    ])].join(" ").toLocaleLowerCase().includes(keyword),
  );
}
