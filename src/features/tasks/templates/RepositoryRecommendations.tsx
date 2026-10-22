import type { TaskRecommendation } from './repositoryRecommendations';
import type { useRepositoryRecommendations } from './useRepositoryRecommendations';
import './templates.css';

export function RepositoryRecommendations({ state, onSelect, action = '填入推荐', disabled = false }: {
  state: ReturnType<typeof useRepositoryRecommendations>;
  onSelect: (recommendation: TaskRecommendation) => void;
  action?: '使用推荐' | '填入推荐';
  disabled?: boolean;
}) {
  return <section className="task-repository-recommendations" aria-label="当前仓库推荐">
    <div className="task-row"><h3>当前仓库推荐</h3><button disabled={disabled || !state.available || state.loading} onClick={state.refresh}>重新检测推荐</button></div>
    <p>根据当前仓库的清单、Run 配方和匹配的验证配置生成。选择后填入可编辑的目标、范围和命令。</p>
    {!state.available && <p role="status">选择已添加的本地仓库后，可在桌面版检测适用流程。</p>}
    {state.loading && <p role="status">正在检测仓库流程…</p>}
    {state.error && <p role="status">仓库推荐暂不可用：{state.error}。仍可填写手动计划。</p>}
    {state.available && !state.loading && !state.error && !state.recommendations.length && <p role="status">未检测到适用的工程流程，请填写实际目标和验证方式。</p>}
    {!!state.recommendations.length && <div className="task-template-grid">{state.recommendations.map(recommendation => <article className="task-template-card" key={recommendation.id}>
      <h4>{recommendation.name}</h4><p>{recommendation.description}</p>
      <small>修改范围：{recommendation.scope.join('、')}</small>
      {!!recommendation.commands.length && <pre className="task-code task-recommendation-commands">{recommendation.commands.join('\n')}</pre>}
      <small>{recommendation.profileSource}</small>
      {recommendation.limitation && <small>{recommendation.limitation}</small>}
      <button disabled={disabled} onClick={() => onSelect(recommendation)}>{action}：{recommendation.name}</button>
    </article>)}</div>}
    {!!state.context?.warnings.length && <details><summary>检测范围与限制</summary><ul>{state.context.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details>}
  </section>;
}
