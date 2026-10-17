import {render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach,describe,it,expect,vi} from 'vitest';
const api=vi.hoisted(()=>({list:vi.fn(),save:vi.fn()}));
vi.mock('@/lib/taskProfiles',()=>({listTaskProfiles:api.list,saveTaskProfile:api.save}));
vi.mock('@/lib/backend',()=>({isDesktopRuntime:()=>true}));
import {ProfileSettings} from './ProfileSettings';
import {useTaskProfileStore} from '@/stores/taskProfiles';
import {newProfile} from './profileModel';
describe('Profile settings',()=>{
 beforeEach(()=>{vi.resetAllMocks();useTaskProfileStore.setState({records:[],loading:false,error:null});api.list.mockResolvedValue([]);});
 it('creates the first Profile without any tasks and preserves structured arguments',async()=>{
   const user=userEvent.setup();api.save.mockImplementation(async({profile})=>({id:profile.id,profile,revision:1,updatedAtMs:1}));render(<ProfileSettings/>);
   await user.click(screen.getByRole('button',{name:'新建 Profile'}));await user.clear(screen.getByLabelText('Profile 名称'));await user.type(screen.getByLabelText('Profile 名称'),'我的检查');
   await user.click(screen.getByRole('button',{name:'添加参数 1'}));await user.type(screen.getByLabelText('Gate 1 参数 2'),'two words 中文');await user.click(screen.getByRole('button',{name:'保存 Profile'}));
   await waitFor(()=>expect(api.save).toHaveBeenCalled());expect(api.save.mock.calls[0][0].profile.gates[0].executor.args).toEqual(['test','two words 中文']);expect(api.save.mock.calls[0][0].expectedRevision).toBeNull();
 });
 it('preserves an edited draft after conflict and offers explicit reload or copy',async()=>{
   const profile=newProfile();api.list.mockResolvedValue([{id:profile.id,profile,revision:1,updatedAtMs:1}]);api.save.mockRejectedValue(new Error('Profile revision conflict'));
   const user=userEvent.setup();render(<ProfileSettings/>);await user.click(await screen.findByRole('button',{name:profile.name}));await user.type(screen.getByLabelText('Profile 名称'),' edited');await user.click(screen.getByRole('button',{name:'保存 Profile'}));
   await screen.findByRole('alert');expect(screen.getByLabelText('Profile 名称')).toHaveValue(profile.name+' edited');expect(screen.getByRole('button',{name:'重新载入所选 Profile'})).toBeVisible();expect(screen.getByRole('button',{name:'复制为新 Profile'})).toBeVisible();
 });
 it('invalid JSON import preserves draft',async()=>{
   const user=userEvent.setup();render(<ProfileSettings/>);await user.click(screen.getByRole('button',{name:'新建 Profile'}));const name=(screen.getByLabelText('Profile 名称') as HTMLInputElement).value;
   await user.type(screen.getByLabelText('导入 Profile JSON'),'invalid');await user.click(screen.getByRole('button',{name:'导入配置'}));await screen.findByRole('alert');expect(screen.getByLabelText('Profile 名称')).toHaveValue(name);
 });
});
it('allows entering multiple source paths on separate lines',async()=>{
 api.list.mockResolvedValue([]);const user=userEvent.setup();render(<ProfileSettings/>);await user.click(screen.getByRole('button',{name:'新建 Profile'}));
 const paths=screen.getByLabelText('sourcePaths（每行一个）');await user.type(paths,'src{Enter}include');expect(paths).toHaveValue('src\ninclude');
});
