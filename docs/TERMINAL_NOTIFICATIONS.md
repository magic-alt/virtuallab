# Terminal agent desktop notifications

VirtualLab offers **non-blocking** desktop alerts for long-running agent work. Terminal PTYs continue running after switching the active workspace or page. The notification center in the application header holds up to 50 in-memory notices per runtime; it is not a durable job log.

## Use

1. Select a worktree and open Terminal.
2. Click **Start Codex with alerts**. This starts a new PTY and runs the local Codex CLI with `-c tui.notifications=true -c tui.notification_method=osc9 -c tui.notification_condition=always`. Overrides are scoped to this Codex process; no global configuration is changed.
3. Start your task and work on another page or application. OSC 9 notifications create an OS toast only when that terminal is not already foreground and focused.
4. Open the **bell** in the top bar to find a completion or attention notice. Selecting it restores the registered workspace and correct terminal pane. Switch off **Desktop alerts** to mute OS notifications while retaining in-app entries.

The **Agents Hub → 工作区会话** surface uses structured `turn/completed` events directly, including the CLI exit outcome. The workbench does not treat `agent.process_exited` as turn success.

## Signal semantics

| Signal | Meaning | UI |
| --- | --- | --- |
| Monitored Codex OSC 9 ordinary message | Codex turn completed | Completed; jump to source terminal |
| Monitored Codex OSC 9 approval/plan prompt | User interaction needed | Attention; jump to terminal |
| Raw OSC 9 in an unmonitored terminal | Terminal program notification, exact task state unknown | Attention only |
| Terminal BEL (`\x07`) outside an OSC | Generic bell, possibly requested input or error | Attention only, throttled per PTY |
| OSC 9;4 progress marker | Progress indication | Ignored for user alerts |
| Quiet output / shell still open / process terminated | Insufficient to prove turn completion | No completion alert |

The parser is incremental and caps OSC control sequences. The original PTY bytes are passed unmodified to xterm.js. Notifications are generated only for native desktop runtime, not the web preview. A system notification contains only fixed status text and a terminal label; prompt text, the OSC payload, assistant output and command logs are **never** sent to OS notifications.

## Manual qualification checklist

- Run two Codex turns in two worktrees. Switch to another page while they are running. Each gets one correctly scoped completion alert and both PTYs remain alive.
- Verify both the minimized/unfocused OS-window case and the active focused Terminal case (no redundant toast for the focused terminal).
- Verify an OSC 9 approval-requested message shows **attention**, not **complete**.
- Verify ordinary BEL (manual `codex` with default notification method) is **attention only**. Rapid bells are throttled to one per 30 seconds per PTY.
- Validate system notifications and notification permission on Windows 11, macOS, and Linux; verify no modal dialog and no new Windows console popup.
- Disable OS notifications and verify the bell inbox continues to work and displays native errors when OS notification delivery fails.
- Close a terminal, remove a worktree, and remove a repository. No notification should relaunch or silently create a PTY.
- Agent structured `turn/completed` / failed turn should create one notice; process-exited should not be called success.

Linux requires a desktop notification service. On Windows/macOS, allow notifications for VirtualLab in OS settings. System toast click-through routing is OS-dependent; selecting the notification **in the application bell inbox** is the supported deep-link path. Runtime provider/browser integration tests do not replace manual visual desktop acceptance.

Agent inbox entries open the matching managed Task when its execution identity matches, or the registered workspace session in Agents Hub. Terminal entries continue opening the original repository Terminal. Merely viewing or navigating a notice does not attach a provider or start work. Toast suppression requires the focused, actually visible matching session; a hidden Hub pane is not considered viewed.
