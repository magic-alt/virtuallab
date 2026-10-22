import { useEffect, useState } from 'react';
import type { RepositoryRecord } from '@/types/workbench';
import { workspaceKey } from '@/lib/workspaceKey';
import { TASK_TEMPLATES, type TaskTemplate } from './catalog';
import { TaskTemplateDialog } from './TaskTemplateDialog';
import { RepositoryRecommendations } from './RepositoryRecommendations';
import { useRepositoryRecommendations } from './useRepositoryRecommendations';
import type { TaskRecommendation } from './repositoryRecommendations';
import './templates.css';

export function TemplateWorkbench({ repositories, activeRepository }: { repositories: RepositoryRecord[]; activeRepository: RepositoryRecord | null }) {
  const [root, setRoot] = useState(activeRepository?.path ?? repositories[0]?.path ?? '');
  const [selected, setSelected] = useState<{ template: TaskTemplate; recommendation?: TaskRecommendation; root: string } | null>(null);
  useEffect(() => { if (activeRepository) setRoot(activeRepository.path); }, [activeRepository?.path]);
  const repository = repositories.find(item => workspaceKey(item.path) === workspaceKey(root)) ?? null;
  const recommendations = useRepositoryRecommendations(root, repositories);
  return <section className="task-surface task-template-library" aria-label="流程模板库">
    <header><p className="task-template-eyebrow">TASK-DRIVEN WORKBENCH</p><h2>从目标到可验证交付</h2><p>从当前仓库的构建、测试、CI 和文档工作开始，确认任务合同后交给真实 Agent 执行。</p></header>
    <label>推荐目标仓库<select value={repository ? root : ''} onChange={event => setRoot(event.target.value)}><option value="" disabled>选择已添加的仓库</option>{repositories.map(item => <option key={item.id} value={item.path}>{item.name} — {item.path}</option>)}</select></label>
    <RepositoryRecommendations state={recommendations} action="使用推荐" onSelect={recommendation => {
      const template = TASK_TEMPLATES.find(item => item.id === recommendation.templateId)!;
      setSelected({ template, recommendation: structuredClone(recommendation), root });
    }}/>
    <h3>通用流程与入门案例</h3>
    <div className="task-template-grid">{TASK_TEMPLATES.filter(template => ['feature', 'bugfix', 'node-demo'].includes(template.id)).map(template => <article className="task-template-card" key={template.id}>
      <span className="task-template-eyebrow">{template.id === 'node-demo' ? '内置可运行案例' : '可复用工程流程'} · v{template.version}</span>
      <h3>{template.name}</h3><p>{template.description}</p>
      <button onClick={() => setSelected({ template, root })}>{template.id === 'node-demo' ? '预览并运行案例' : `使用${template.name}模板`}</button>
    </article>)}</div>
    <p className="task-template-footnote">参照 Superpowers 的可组合方法设计；不要求安装 Superpowers 插件。现有手动计划、多节点依赖图与工程仓库工具保持独立可用。</p>
    {selected && <TaskTemplateDialog key={`${selected.template.id}:${selected.recommendation?.id ?? ''}:${selected.root}`} template={selected.template} recommendation={selected.recommendation} repositories={repositories} activeRepository={repositories.find(item => workspaceKey(item.path) === workspaceKey(selected.root)) ?? null} onClose={() => setSelected(null)}/>}
  </section>;
}
