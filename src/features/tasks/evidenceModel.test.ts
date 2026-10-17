import {describe,it,expect} from 'vitest';
import {taskEvidenceRows} from './evidenceModel';
import {taskFixture} from './fixtures';
import type {TaskAttempt} from '@/types/tasks';
export const evidenceAttempt=(id:string,time:number,status:'pass'|'fail'='pass'):TaskAttempt=>({id,state:'succeeded',phase:'verification',candidateSha:'same-sha',failure:null,startedAtMs:1,endedAtMs:2,evidence:{runId:`run-${id}`,headSha:'same-sha',profileDigest:'p',inputDigest:'i',toolchainDigest:'t',status,checks:[{gateId:'unit',status,detail:'observed check',startedAtMs:1}],artifacts:[],observedAtMs:time}});
describe('immutable evidence rows',()=>{
 it('includes old failed and current Runs with stable task and Attempt ties',()=>{
  const task=taskFixture({attempts:[evidenceAttempt('old',1,'fail'),evidenceAttempt('new',2)]});
  const other=taskFixture({id:'task-0',attempts:[evidenceAttempt('b',2),evidenceAttempt('a',2)]});
  const rows=taskEvidenceRows([task,other]);expect(rows.map(r=>[r.taskId,r.attemptId])).toEqual([['task-0','a'],['task-0','b'],['task-1','new'],['task-1','old']]);expect(rows[3].evidence.status).toBe('fail');
 });
});
