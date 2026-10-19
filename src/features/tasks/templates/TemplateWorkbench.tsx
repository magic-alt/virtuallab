import { useState } from 'react';
import type { RepositoryRecord } from '@/types/workbench';
import { TASK_TEMPLATES, type TaskTemplate } from './catalog';
import { TaskTemplateDialog } from './TaskTemplateDialog';
import './templates.css';

export function TemplateWorkbench({ repositories, activeRepository }: { repositories: RepositoryRecord[]; activeRepository: RepositoryRecord | null }) {
  const [selected, setSelected] = useState<TaskTemplate | null>(null);
  return <section className="task-surface task-template-library" aria-label="流程模板库">
    <header><p className="task-template-eyebrow">TASK-DRIVEN WORKBENCH</p><h2>从目标到可验证交付</h2><p>选择方法，确认任务合同，让真实 Agent 执行。计划、工作区、检查和人工验收分别留痕。</p></header>
    <div className="task-template-grid">{TASK_TEMPLATES.map(template => <article className="task-template-card" key={template.id}>
      <span className="task-template-eyebrow">{template.id === 'node-demo' ? '内置可运行案例' : '可复用工程流程'} · v{template.version}</span>
      <h3>{template.name}</h3><p>{template.description}</p>
      <button onClick={() => setSelected(template)}>{template.id === 'node-demo' ? '预览并运行案例' : `使用${template.name}模板`}</button>
    </article>)}</div>
    <p className="task-template-footnote">参照 Superpowers 的可组合方法设计；不要求安装 Superpowers 插件。现有手动计划、多节点依赖图与工程仓库工具保持独立可用。</p>
    {selected && <TaskTemplateDialog key={selected.id} template={selected} repositories={repositories} activeRepository={activeRepository} onClose={() => setSelected(null)}/>}
  </section>;
}
