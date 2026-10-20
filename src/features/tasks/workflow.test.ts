import {describe,it,expect} from 'vitest';
import {nextTaskStep,taskQueues} from './workflow';
import {taskFixture,readinessFixture} from './fixtures';
import {newProfile} from '@/features/task-profiles/profileModel';
import type {TaskAttempt} from '@/types/tasks';
const attempt=(state:TaskAttempt['state']):TaskAttempt=>({id:'a',state,phase:'implementation',candidateSha:null,failure:null,startedAtMs:1,endedAtMs:null,evidence:null});
describe('native-derived task guidance',()=>{
 it('prioritizes active/stopping work, missing configuration and explicit preparation',()=>{
  expect(nextTaskStep(taskFixture({attempts:[attempt('stopping')]})).tab).toBe('执行');
  expect(nextTaskStep(taskFixture({profile:newProfile(),workspaceRoot:null})).tab).toBe('概览');
  expect(nextTaskStep(taskFixture()).label).toBe('启动 Agent 执行');
  expect(nextTaskStep(taskFixture({workspaceRoot:null,profile:null})).label).toBe('准备工作区');
  expect(nextTaskStep(taskFixture()).detail).toMatch(/Profile/);
 });
 it('never promotes provider completion and historical PASS without native readiness',()=>{
  const evidence={runId:'old',headSha:'same',inputDigest:'i',profileDigest:'p',toolchainDigest:'t',status:'pass' as const,checks:[],artifacts:[],observedAtMs:1};
  const task=taskFixture({profile:newProfile(),attempts:[{...attempt('succeeded'),evidence}]});
  const queues=taskQueues([task],{});expect(queues.accepted).toEqual([]);expect(queues.review).toEqual([]);expect(queues.staleEvidence).toEqual([task]);
  expect(nextTaskStep(task).tab).toBe('证据');
 });
 it('routes native integration blockers and failed verification to existing controls',()=>{
  const task=taskFixture({profile:newProfile(),kind:'integration',dependencies:['dependency']});
  expect(nextTaskStep(task,readinessFixture({blockers:['依赖证据过期']})).detail).toMatch(/依赖证据过期/);
  const failed=taskFixture({profile:newProfile(),attempts:[attempt('failed')]});expect(taskQueues([failed],{}).failedChecks).toEqual([failed]);
 });
 it.each(['failed','interrupted'] as const)('prioritizes the latest %s implementation failure over missing delivery configuration',state=>{
  const failure='Git content conversion is not qualified; use a byte-preserving configuration or manual candidate review.';
  const task=taskFixture({profile:null,attempts:[{...attempt(state),failure}]});
  expect(nextTaskStep(task,readinessFixture({blockers:['尚未指定验收 Profile']}))).toEqual({
   label:'检查失败并恢复',detail:failure,tab:'执行',
  });
 });
 it('requires a real acceptance record plus native currentness and labels overlapping queues',()=>{
  const task=taskFixture({acceptance:{headSha:'h',inputDigest:'i',profileDigest:'p',acceptedAtMs:1,acknowledgedWarnings:false}});
  expect(taskQueues([task],{[task.id]:readinessFixture({acceptanceCurrent:true,status:'ready'})}).accepted).toEqual([task]);
  expect(taskQueues([task],{[task.id]:readinessFixture()}).accepted).toEqual([]);
  expect(taskQueues([task],{}).needsInput).toEqual([task]);
 });
 it('offers human review only when native reports review as the sole blocker',()=>{
  const task=taskFixture({profile:newProfile(),attempts:[attempt('succeeded')]});
  const review=readinessFixture({blockers:['需要对当前版本完成人工审查']});
  expect(taskQueues([task],{[task.id]:review}).review).toEqual([task]);
  expect(nextTaskStep(task,review).tab).toBe('变更与审查');
  expect(taskQueues([task],{[task.id]:{...review,blockers:[...review.blockers,'源码已变化']}}).review).toEqual([]);
 });
});
it('keeps prepared tasks and verified tasks awaiting acceptance actionable on the dashboard',()=>{
 const prepared=taskFixture({profile:newProfile()});const ready=readinessFixture({status:'ready',reviewCurrent:true});
 expect(taskQueues([prepared],{[prepared.id]:readinessFixture({blockers:['任务尚未执行']})}).needsInput).toEqual([prepared]);expect(nextTaskStep(prepared).tab).toBe('执行');
 const verified=taskFixture({profile:newProfile(),attempts:[attempt('succeeded')]});expect(taskQueues([verified],{[verified.id]:ready}).needsInput).toEqual([verified]);expect(nextTaskStep(verified,ready).tab).toBe('交付');
});
it('routes failed integration to explicit repair and verification instead of replaying a preview',()=>{
 for(const state of ['failed','interrupted'] as const){const task=taskFixture({kind:'integration',profile:newProfile(),attempts:[{...attempt(state),phase:'integration'}]});const step=nextTaskStep(task,readinessFixture());expect(step.tab).toBe('证据');expect(step.detail).toMatch(/提交/);}
});
