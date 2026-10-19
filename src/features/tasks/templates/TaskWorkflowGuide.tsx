import type { TaskDetailTab, TaskReadiness, TaskRecord } from '@/types/tasks';
import { templateForGoal } from './catalog';
import { workflowStages } from './stages';
import './templates.css';
const labels = {done:'已观察',active:'进行中',pending:'待处理',blocked:'需处理'};

export function TaskWorkflowGuide({ task, readiness, onNavigate }: { task: TaskRecord; readiness?: TaskReadiness; onNavigate: (tab: TaskDetailTab) => void }) {
  const template = templateForGoal(task.goal);
  return <section className="task-surface task-workflow-guide" aria-label="任务流程导航">
    <header><h2>交付流程</h2><p>{template ? `${template.name} · 模板 v${template.version}` : '手动任务合同'} · 以下状态来自任务记录和当前原生就绪结果。</p></header>
    <ol className="task-workflow-stages">{workflowStages(task, readiness).map((stage, index) => <li key={stage.id} data-state={stage.state}>
      <button onClick={() => onNavigate(stage.tab)}><span>{index + 1}. {stage.label}</span><small>{labels[stage.state]}</small></button><p>{stage.detail}</p>
    </li>)}</ol>
    <p className="task-template-footnote">导航不会开始任务。目标澄清、TDD 和自查属于 Agent 方法指令；没有独立阶段证据时，不显示为已完成。</p>
  </section>;
}
