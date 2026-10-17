import {create} from 'zustand';
import {listTaskProfiles,saveTaskProfile} from '@/lib/taskProfiles';
import type {TaskProfileRecord,SaveTaskProfileRequest} from '@/types/taskProfiles';
interface ProfileState {records:TaskProfileRecord[];loading:boolean;error:string|null}
export const useTaskProfileStore=create<ProfileState>(()=>({records:[],loading:false,error:null}));
let sequence=0;
const message=(e:unknown)=>e instanceof Error?e.message:String(e);
export async function refreshTaskProfiles():Promise<void> {
 const request=++sequence;useTaskProfileStore.setState({loading:true,error:null});
 try {const records=await listTaskProfiles();if(request===sequence)useTaskProfileStore.setState({records,loading:false});}
 catch(e){if(request===sequence)useTaskProfileStore.setState({loading:false,error:message(e)});}
}
export async function saveProfile(request:SaveTaskProfileRequest):Promise<TaskProfileRecord> {
 ++sequence;useTaskProfileStore.setState({loading:false});
 try {const record=await saveTaskProfile(request);++sequence;
   useTaskProfileStore.setState(state=>({loading:false,error:null,records:[...state.records.filter(r=>r.id!==record.id),state.records.find(r=>r.id===record.id && r.revision>record.revision)??record]}));return record;
 }catch(e){++sequence;useTaskProfileStore.setState({loading:false,error:message(e)});throw e;}
}
