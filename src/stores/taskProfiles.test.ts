import {beforeEach,describe,it,expect,vi} from 'vitest';
const api=vi.hoisted(()=>({list:vi.fn(),save:vi.fn()}));
vi.mock('@/lib/taskProfiles',()=>({listTaskProfiles:api.list,saveTaskProfile:api.save}));
import {useTaskProfileStore,refreshTaskProfiles,saveProfile} from './taskProfiles';
const profile={schemaVersion:1 as const,id:'p',name:'Profile',gates:[]};
const record=(revision:number)=>({id:'p',revision,profile,updatedAtMs:1});
describe('Profile library requests',()=>{
 beforeEach(()=>{vi.resetAllMocks();useTaskProfileStore.setState({records:[],loading:false,error:null});});
 it('rejects a delayed refresh after a successful save',async()=>{
   let finish!:(value:ReturnType<typeof record>[])=>void;api.list.mockImplementation(()=>new Promise(r=>finish=r));
   const read=refreshTaskProfiles();api.save.mockResolvedValue(record(2));await saveProfile({profile,expectedRevision:1});finish([record(1)]);await read;
   expect(useTaskProfileStore.getState().records[0].revision).toBe(2);expect(useTaskProfileStore.getState().loading).toBe(false);
 });
 it('retains existing records when native save reports a revision conflict',async()=>{
   useTaskProfileStore.setState({records:[record(2)]});api.save.mockRejectedValue(new Error('revision conflict'));
   await expect(saveProfile({profile,expectedRevision:1})).rejects.toThrow(/conflict/);expect(useTaskProfileStore.getState().records[0].revision).toBe(2);
 });
});
