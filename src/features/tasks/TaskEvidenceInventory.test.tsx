import {render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe,it,expect,vi} from 'vitest';
import {TaskEvidenceInventory} from './TaskEvidenceInventory';
import {taskFixture,readinessFixture} from './fixtures';
import type {TaskAttempt} from '@/types/tasks';
const attempt=(id:string,status:'pass'|'fail'):TaskAttempt=>({id,state:'succeeded',phase:'verification',candidateSha:'same-sha',failure:null,startedAtMs:1,endedAtMs:2,evidence:{runId:`run-${id}`,headSha:'same-sha',profileDigest:'p',inputDigest:'i',toolchainDigest:'t',status,checks:[{gateId:'unit',status,detail:'observed check',startedAtMs:1}],artifacts:[],observedAtMs:1}});
describe('Run inventory',()=>{
 it('shows historical failures and never grants currentness from matching SHA',async()=>{
  const task=taskFixture({attempts:[attempt('old','fail'),attempt('new','pass')]});const open=vi.fn();const page=render(<TaskEvidenceInventory tasks={[task]} readiness={{[task.id]:readinessFixture({candidateSha:'same-sha'})}} loading={false} onOpenTask={open}/>);
  await userEvent.click(screen.getByRole('button',{name:'查看 Run run-old'}));expect(screen.getByText('observed check')).toBeVisible();expect(screen.getByText(/已被后续 Attempt 取代/)).toBeVisible();expect(screen.queryByText('当前可交付')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button',{name:'打开此 Run 的任务'}));expect(open).toHaveBeenCalledWith(task.id,'证据');
  await userEvent.selectOptions(screen.getByLabelText('检查结果筛选'),'pass');expect(screen.queryByRole('button',{name:'查看 Run run-old'})).not.toBeInTheDocument();
  page.rerender(<TaskEvidenceInventory tasks={[]} readiness={{}} loading={false} onOpenTask={open}/>);expect(screen.queryByText('observed check')).not.toBeInTheDocument();
 });
 it('filters repository and task, keeping unavailable observations explicit',async()=>{
  const a=taskFixture({attempts:[attempt('a','pass')]});const b=taskFixture({id:'other',title:'Other',repositoryRoot:'/other',attempts:[attempt('b','fail')]});render(<TaskEvidenceInventory tasks={[a,b]} readiness={{}} loading={false} onOpenTask={vi.fn()}/>);
  await userEvent.selectOptions(screen.getByLabelText('证据仓库筛选'),'/other');expect(screen.queryByRole('button',{name:'查看 Run run-a'})).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button',{name:'查看 Run run-b'}));expect(screen.getByText(/适用性未知/)).toBeVisible();
 });
});
