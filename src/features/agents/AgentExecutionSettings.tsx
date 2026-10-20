import { ProfileSettings } from '@/features/task-profiles/ProfileSettings';
import { useAgentPreferences } from '@/stores/agentPreferences';

export function AgentExecutionSettings({ onOpenSession, onOpenRun }: { onOpenSession: () => void; onOpenRun?: () => void }) {
  const preferences = useAgentPreferences();
  return <div className="agent-execution-settings">
    <section className="task-surface" aria-labelledby="agent-executable-heading">
      <h2 id="agent-executable-heading">Agent 执行程序</h2>
      <label>默认 Codex 可执行程序<input value={preferences.codexExecutablePath} onChange={event => preferences.setCodexExecutablePath(event.target.value)} placeholder="留空时自动检测本机 Codex"/></label>
      <p className="task-muted">用于新任务、手动启动、重试和新的 Codex 连接。可在单次执行中覆盖；正在运行的任务保持原来的程序。</p>
      <div className="task-row"><button type="button" onClick={onOpenSession}>管理 Provider 与会话</button>{onOpenRun && <button type="button" onClick={onOpenRun}>打开 Run 配置</button>}</div>
    </section>
    <ProfileSettings/>
  </div>;
}
