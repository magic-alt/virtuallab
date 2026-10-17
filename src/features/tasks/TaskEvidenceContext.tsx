import type {TaskEvidence} from '@/types/tasks';
import {statusLabels} from './model';
export function TaskEvidenceContext({evidence}: {evidence: TaskEvidence}) {
  return <><dl className="task-facts"><dt>Run</dt><dd>{evidence.runId}</dd><dt>HEAD</dt><dd>{evidence.headSha}</dd><dt>检查结果（历史观察）</dt><dd>{statusLabels[evidence.status]}</dd><dt>输入摘要</dt><dd>{evidence.inputDigest}</dd><dt>Profile 摘要</dt><dd>{evidence.profileDigest}</dd><dt>工具链摘要</dt><dd>{evidence.toolchainDigest}</dd><dt>Manifest 摘要</dt><dd>{evidence.manifestDigest ?? '历史记录（未绑定 manifest）'}</dd><dt>观察时间</dt><dd>{new Date(evidence.observedAtMs).toLocaleString()}</dd></dl>
          <h3>Checks</h3><ul>{evidence.checks.map(check => <li key={check.gateId}>{check.gateId} · {statusLabels[check.status]}<p>{check.detail}</p></li>)}</ul><h3>Artifacts</h3><ul>{evidence.artifacts.map(artifact => <li key={artifact.id}><code>{artifact.path}</code> · {artifact.sha256 ?? '摘要不可用'}</li>)}</ul></>;
}
