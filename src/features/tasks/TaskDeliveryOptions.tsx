export interface TaskDeliverySettings {
  autoCommit: boolean;
  autoDraftPr: boolean;
  baseBranch: string;
}

/** One explicit creation-time authorization; Native owns all GitHub writes. */
export function TaskDeliveryOptions({ autoCommit, autoDraftPr, baseBranch, onChange, disabled = false, canDeliver = true }: TaskDeliverySettings & {
  onChange: (value: TaskDeliverySettings) => void;
  disabled?: boolean;
  canDeliver?: boolean;
}) {
  return <section className="task-delivery-options" aria-label="任务提交方式">
    <label className="task-checkbox"><input type="checkbox" checked={autoCommit} disabled={disabled}
      onChange={event => onChange({autoCommit:event.target.checked, autoDraftPr:event.target.checked && autoDraftPr, baseBranch})}/>
      完成后创建本地提交</label>
    <label className="task-checkbox"><input type="checkbox" checked={autoDraftPr && canDeliver} disabled={disabled || !canDeliver}
      onChange={event => onChange({autoCommit:event.target.checked || autoCommit, autoDraftPr:event.target.checked, baseBranch})}/>
      完成后自动创建 Draft PR</label>
    {canDeliver ? <p>勾选后允许 VirtualLab 封存任务修改、推送任务分支，并在 origin 对应的 GitHub 仓库创建草稿 PR。需要本机 Git 推送权限和已登录的 GitHub CLI（gh）。</p>
      : <p>集成节点使用下方的本地集成与验收流程；自动 PR 适用于实现节点。</p>}
    {autoDraftPr && canDeliver && <>
      <label>PR 目标分支（可选）<input value={baseBranch} disabled={disabled} placeholder="留空使用 GitHub 仓库默认分支"
        onChange={event => onChange({autoCommit,autoDraftPr,baseBranch:event.target.value})}/></label>
      <p>已配置的正式验证通过后才会提交；未配置验证时，草稿 PR 会明确标注未验证。执行结果和 PR 提交状态会分别保留。</p>
    </>}
  </section>;
}
