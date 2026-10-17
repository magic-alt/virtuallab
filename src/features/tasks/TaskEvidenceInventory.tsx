import {useState} from 'react';
import {workspaceKey} from '@/lib/workspaceKey';
import type {TaskRecord,TaskReadiness,TaskDetailTab} from '@/types/tasks';
import {taskEvidenceRows} from './evidenceModel';
import type {EvidenceRow} from './evidenceModel';
import {TaskEvidenceContext} from './TaskEvidenceContext';
import {statusLabels} from './model';
const rowKey=(row:EvidenceRow)=>JSON.stringify([row.taskId,row.attemptId,row.evidence.runId]);
export function TaskEvidenceInventory({tasks,readiness,loading,error,onOpenTask}:{tasks:TaskRecord[];readiness:Record<string,TaskReadiness>;loading:boolean;error?:string|null;onOpenTask:(id:string,tab:TaskDetailTab)=>void}) {
 const [root,setRoot]=useState('');const [taskId,setTaskId]=useState('');const [status,setStatus]=useState('');const [selection,setSelection]=useState('');
 const roots=[...new Set(tasks.map(t=>t.repositoryRoot))];const effectiveRoot=roots.some(r=>workspaceKey(r)===workspaceKey(root))?root:'';
 const visibleTasks=tasks.filter(t=>!effectiveRoot||workspaceKey(t.repositoryRoot)===workspaceKey(effectiveRoot));const effectiveTask=visibleTasks.some(t=>t.id===taskId)?taskId:'';
 const rows=taskEvidenceRows(visibleTasks.filter(t=>!effectiveTask||t.id===effectiveTask)).filter(row=>!status||row.evidence.status===status);
 const selected=rows.find(row=>rowKey(row)===selection);const selectedTask=tasks.find(t=>t.id===selected?.taskId);const superseded=!!selected&&selectedTask?.attempts.at(-1)?.id!==selected.attemptId;
 const native=selected?readiness[selected.taskId]:undefined;
 return <section aria-label="验证 Run 清单"><h2>验证 Run 清单</h2><p>包含已保存任务的历史观察；不是完整归档发现。检查结果与当前交付状态分别展示。</p>
  <div className="task-filters"><label>证据仓库筛选<select value={effectiveRoot} onChange={e=>{setRoot(e.target.value);setTaskId('');setSelection('');}}><option value="">全部仓库</option>{roots.map(r=><option key={r} value={r}>{r}</option>)}</select></label>
  <label>证据任务筛选<select value={effectiveTask} onChange={e=>{setTaskId(e.target.value);setSelection('');}}><option value="">全部任务</option>{visibleTasks.map(t=><option key={t.id} value={t.id}>{t.title}</option>)}</select></label>
  <label>检查结果筛选<select value={status} onChange={e=>{setStatus(e.target.value);setSelection('');}}><option value="">全部结果</option>{['pass','warn','fail','blocked','cancelled','not_run','running'].map(s=><option key={s} value={s}>{statusLabels[s]??s}</option>)}</select></label></div>
  {loading?<p>正在读取原生证据…</p>:error?<p role="status">原生证据不可用：{error}</p>:<>
  <div className="task-evidence-table"><table><thead><tr>{['任务 / 仓库','Attempt / Run','测试 SHA','历史结果','观察时间','详情'].map(s=><th key={s} scope="col">{s}</th>)}</tr></thead><tbody>{rows.map(row=><tr key={rowKey(row)}><td>{row.taskTitle}<br/>{row.repositoryRoot}</td><td>{row.attemptId}<br/>{row.evidence.runId}</td><td><code>{row.evidence.headSha}</code></td><td>{statusLabels[row.evidence.status]}</td><td>{new Date(row.evidence.observedAtMs).toLocaleString()}</td><td><button aria-pressed={selection===rowKey(row)} onClick={()=>setSelection(rowKey(row))}>查看 Run {row.evidence.runId}</button></td></tr>)}</tbody></table></div>
  {!rows.length&&<p>没有匹配的已保存验证 Run。</p>}
  {selected&&<section className="task-node" aria-label="Run 详情"><h3>{selected.evidence.runId}</h3><p>{superseded?'历史记录：已被后续 Attempt 取代。':'此 Run 属于最新 Attempt；当前适用性仍由 Native 判断。'}</p>
   <p>{!native?'当前交付适用性未知。':superseded?'此历史 Run 不授予当前交付资格。':`当前任务交付状态：${statusLabels[native.status]??native.status}。`}</p>
   {!superseded&&native?.blockers.map((b,i)=><p key={i}>{b}</p>)}<TaskEvidenceContext evidence={selected.evidence}/><button onClick={()=>onOpenTask(selected.taskId,'证据')}>打开此 Run 的任务</button></section>}
  </>}
 </section>;
}
