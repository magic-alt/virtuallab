import type {TaskRecord,TaskEvidence} from '@/types/tasks';
export interface EvidenceRow {taskId:string;taskTitle:string;repositoryRoot:string;attemptId:string;evidence:TaskEvidence}
export function taskEvidenceRows(tasks:TaskRecord[]):EvidenceRow[] {
 return tasks.flatMap(t=>t.attempts.flatMap(a=>a.evidence?[{taskId:t.id,taskTitle:t.title,repositoryRoot:t.repositoryRoot,attemptId:a.id,evidence:a.evidence}]:[]))
  .sort((a,b)=>b.evidence.observedAtMs-a.evidence.observedAtMs||(a.taskId<b.taskId?-1:a.taskId>b.taskId?1:0)||(a.attemptId<b.attemptId?-1:a.attemptId>b.attemptId?1:0));
}
