import {act,fireEvent,render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach,it,expect,vi} from 'vitest';
const api=vi.hoisted(()=>({list:vi.fn(),save:vi.fn()}));
vi.mock('@/lib/taskProfiles',()=>({listTaskProfiles:api.list,saveTaskProfile:api.save}));
vi.mock('@/lib/backend',()=>({isDesktopRuntime:()=>true}));
import {ProfileSettings} from './ProfileSettings';
import {useTaskProfileStore} from '@/stores/taskProfiles';
import {newProfile} from './profileModel';
beforeEach(()=>{vi.resetAllMocks();useTaskProfileStore.setState({records:[],loading:false,error:null});});
it('does not overwrite edits made after an explicit delayed reload',async()=>{
 const profile=newProfile();const record={id:profile.id,revision:1,profile,updatedAtMs:1};let resolve!:(records:typeof record[])=>void;
 api.list.mockResolvedValueOnce([record]).mockImplementationOnce(()=>new Promise(r=>resolve=r));const user=userEvent.setup();render(<ProfileSettings/>);
 await user.click(await screen.findByRole('button',{name:profile.name}));await user.click(screen.getByRole('button',{name:'重新载入所选 Profile'}));await user.type(screen.getByLabelText('Profile 名称'),' local edit');
 await act(async()=>resolve([{...record,revision:2,profile:{...profile,name:'Remote edit'}}]));expect(screen.getByLabelText('Profile 名称')).toHaveValue(profile.name+' local edit');
});
it('saves the visible advanced JSON rather than silently reverting to the old form draft',async()=>{
 api.list.mockResolvedValue([]);api.save.mockImplementation(async({profile})=>({id:profile.id,revision:1,profile,updatedAtMs:1}));const user=userEvent.setup();render(<ProfileSettings/>);
 await user.click(screen.getByRole('button',{name:'新建 Profile'}));const edited={...newProfile(),name:'Advanced edit'};fireEvent.change(screen.getByLabelText('高级 Profile JSON'),{target:{value:JSON.stringify(edited)}});await user.click(screen.getByRole('button',{name:'保存 Profile'}));
 expect(api.save.mock.calls[0][0].profile).toEqual(edited);
});
it('exports the current advanced JSON as a configuration that can be imported unchanged',async()=>{
 api.list.mockResolvedValue([]);let exported:Blob|undefined;
 const oldCreate=URL.createObjectURL;const oldRevoke=URL.revokeObjectURL;
 const revoke=vi.fn();URL.createObjectURL=vi.fn(blob=>{exported=blob as Blob;return 'blob:configuration';});URL.revokeObjectURL=revoke;
 vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
 try {
  const user=userEvent.setup();render(<ProfileSettings/>);await user.click(screen.getByRole('button',{name:'新建 Profile'}));
  const profile={...newProfile(),name:'导出配置',toolchainPrograms:['compiler']};
  fireEvent.change(screen.getByLabelText('高级 Profile JSON'),{target:{value:JSON.stringify(profile)}});await user.click(screen.getByRole('button',{name:'导出配置'}));expect(exported).toBeDefined();
  const text=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=reject;reader.readAsText(exported!);});
  const {parseProfileDocument}=await import('./profileModel');expect(parseProfileDocument(text)).toEqual(profile);
  const {waitFor}=await import('@testing-library/react');await waitFor(()=>expect(revoke).toHaveBeenCalledWith('blob:configuration'));
 }finally{URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;}
});
