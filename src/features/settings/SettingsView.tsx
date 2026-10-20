import { EXTERNAL_EDITORS, savePreferredEditor, usePreferredEditor, type ExternalEditor } from '@/lib/externalEditor';
import { useTaskNotifications } from '@/stores/taskNotifications';
import {
  DEFAULT_TERMINAL_FONT_SIZE, MIN_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE,
  TERMINAL_SCROLLBACK_OPTIONS, setTerminalFontSize, useTerminalFontSize,
  setTerminalScrollback, useTerminalScrollback, setTerminalCursorBlink, useTerminalCursorBlink,
} from '@/features/terminal/terminalAppearance';
import './settings.css';

/** Global local preferences remain usable without repositories or native task data. */
export function SettingsView({ onOpenAgentSettings }: { onOpenAgentSettings?: () => void }) {
  const editor = usePreferredEditor();
  const desktopEnabled = useTaskNotifications(state => state.desktopEnabled);
  const desktopError = useTaskNotifications(state => state.desktopError);
  const setDesktopEnabled = useTaskNotifications(state => state.setDesktopEnabled);
  const fontSize = useTerminalFontSize();
  const scrollback = useTerminalScrollback();
  const cursorBlink = useTerminalCursorBlink();

  return <main className="settings-view" aria-label="设置">
    <header><h1>设置</h1><p>管理这台设备上的工作台偏好。更改立即生效并自动保存。</p></header>
    <section aria-labelledby="settings-workbench-heading">
      <h2 id="settings-workbench-heading">工作台</h2>
      <div className="settings-row">
        <div><label htmlFor="settings-editor">默认 IDE</label><p id="settings-editor-help">工程仓库中的“打开 IDE”使用此选择；自动检测会寻找本机支持的编辑器。</p></div>
        <select id="settings-editor" aria-describedby="settings-editor-help" value={editor} onChange={event => savePreferredEditor(event.target.value as ExternalEditor)}>
          {EXTERNAL_EDITORS.map(option => <option key={option.id} value={option.id}>{option.id === 'auto' ? '自动检测' : option.label}</option>)}
        </select>
      </div>
      <div className="settings-row">
        <div><h3 id="settings-notifications-label">桌面任务通知</h3><p id="settings-notifications-help">Agent 或终端任务完成、失败或需要关注时发送系统通知。应用内通知始终保留。</p></div>
        <button type="button" className="settings-switch" role="switch" aria-labelledby="settings-notifications-label" aria-describedby="settings-notifications-help" aria-checked={desktopEnabled} onClick={() => setDesktopEnabled(!desktopEnabled)}>{desktopEnabled ? '已开启' : '已关闭'}</button>
      </div>
      {desktopEnabled && desktopError && <p role="status" className="settings-error">系统通知暂不可用：{desktopError}。应用内通知仍可查看。</p>}
    </section>
    <section aria-labelledby="settings-terminal-heading">
      <h2 id="settings-terminal-heading">终端</h2>
      <p>所有工作区共用这些偏好，包括已打开的终端。</p>
      <div className="settings-row">
        <div><label htmlFor="settings-terminal-font">终端字号</label><p id="settings-terminal-font-help">默认 {DEFAULT_TERMINAL_FONT_SIZE}px；也可在终端工具栏调整。</p></div>
        <select id="settings-terminal-font" aria-describedby="settings-terminal-font-help" value={fontSize} onChange={event => setTerminalFontSize(Number(event.target.value))}>
          {Array.from({length:MAX_TERMINAL_FONT_SIZE - MIN_TERMINAL_FONT_SIZE + 1}, (_, index) => MIN_TERMINAL_FONT_SIZE + index).map(size => <option key={size} value={size}>{size}px</option>)}
        </select>
      </div>
      <div className="settings-row">
        <div><label htmlFor="settings-terminal-scrollback">终端回滚行数</label><p id="settings-terminal-scrollback-help">默认 8,000 行。较大值占用更多内存；减小会丢弃超出上限的旧输出。</p></div>
        <select id="settings-terminal-scrollback" aria-describedby="settings-terminal-scrollback-help" value={scrollback} onChange={event => setTerminalScrollback(Number(event.target.value))}>
          {TERMINAL_SCROLLBACK_OPTIONS.map(lines => <option key={lines} value={lines}>{lines.toLocaleString('en-US')} 行</option>)}
        </select>
      </div>
      <div className="settings-row">
        <div><h3 id="settings-terminal-cursor-label">终端光标闪烁</h3><p id="settings-terminal-cursor-help">关闭后使用静止光标，立即应用到现有终端。</p></div>
        <button type="button" className="settings-switch" role="switch" aria-labelledby="settings-terminal-cursor-label" aria-describedby="settings-terminal-cursor-help" aria-checked={cursorBlink} onClick={() => setTerminalCursorBlink(!cursorBlink)}>{cursorBlink ? '已开启' : '已关闭'}</button>
      </div>
    </section>
    {onOpenAgentSettings && <section aria-labelledby="settings-agents-heading">
      <h2 id="settings-agents-heading">Agent 执行配置</h2><p>在 Agents Hub 管理默认执行程序、验证 Profile 和工作区会话。</p>
      <button type="button" onClick={onOpenAgentSettings}>打开 Agent 执行配置</button>
    </section>}
  </main>;
}
