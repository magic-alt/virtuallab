import {render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach,describe,it,expect,vi} from 'vitest';
const api=vi.hoisted(()=>({list:vi.fn()}));
vi.mock('@/lib/taskProfiles',()=>({listTaskProfiles:api.list,saveTaskProfile:vi.fn()}));
vi.mock('@/lib/backend',()=>({isDesktopRuntime:()=>true,inspectRepository:vi.fn()}));
import {TaskPlanWizard} from './TaskPlanWizard';
import {useTaskStore} from '@/stores/tasks';
import {useTaskProfileStore} from '@/stores/taskProfiles';
import {newProfile} from '@/features/task-profiles/profileModel';
const repo={id:'r',name:'Repo',path:'/repo',lastOpenedAt:1};
describe('wizard saved Profile snapshot',()=>{
 beforeEach(()=>{useTaskStore.setState({tasks:[],pending:{}});useTaskProfileStore.setState({records:[],loading:false,error:null});});
 it('loads a library with no tasks and does not overwrite copied JSON after a library edit',async()=>{
  const p=newProfile();api.list.mockResolvedValue([{id:p.id,revision:1,profile:p,updatedAtMs:1}]);const user=userEvent.setup();render(<TaskPlanWizard repositories={[repo]} activeRepository={repo} onClose={vi.fn()}/>);
  await user.type(screen.getByLabelText('计划标题'),'Title');await user.type(screen.getByLabelText('目标'),'Goal');await user.type(screen.getByLabelText('基线 HEAD'),'b'.repeat(40));await user.click(screen.getByRole('button',{name:'下一步'}));
  await waitFor(()=>expect(screen.getByRole('option',{name:`${p.name} · 库修订 1`})).toBeInTheDocument());await user.selectOptions(screen.getByLabelText('已保存 Profile'),'library:checks');
  const copied=(screen.getByLabelText('Profile JSON') as HTMLTextAreaElement).value;expect(JSON.parse(copied)).toEqual(p);
  const {act}=await import('@testing-library/react');act(()=>useTaskProfileStore.setState({records:[{id:p.id,revision:2,profile:{...p,name:'Changed'},updatedAtMs:2}]}));expect(screen.getByLabelText('Profile JSON')).toHaveValue(copied);
 });
});
