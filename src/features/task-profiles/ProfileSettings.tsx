import {useEffect,useRef,useState} from 'react';
import {isDesktopRuntime} from '@/lib/backend';
import {useTaskProfileStore,refreshTaskProfiles,saveProfile} from '@/stores/taskProfiles';
import type {TaskVerificationProfile} from '@/types/tasks';
import type {TaskProfileRecord} from '@/types/taskProfiles';
import {ProfileEditor} from './ProfileEditor';
import {copyProfile,newProfile,parseProfileDocument} from './profileModel';
export function ProfileSettings() {
 const state=useTaskProfileStore();const [draft,setDraft]=useState<TaskVerificationProfile|null>(null);const [selected,setSelected]=useState<TaskProfileRecord|null>(null);
 const [json,setJson]=useState('');const [importText,setImportText]=useState('');const [error,setError]=useState('');const [busy,setBusy]=useState(false);
 const epoch=useRef(0);const lock=useRef(false);
 useEffect(()=>{void refreshTaskProfiles();return()=>{++epoch.current;};},[]);
 const edit=(profile:TaskVerificationProfile)=>{++epoch.current;setDraft(profile);setJson(JSON.stringify(profile,null,2));};
 const choose=(record:TaskProfileRecord|null)=>{++epoch.current;setSelected(record);edit(record?copyProfile(record.profile):newProfile());setError('');};
 const save=async()=>{
   if(!draft||lock.current)return;lock.current=true;setBusy(true);setError('');const generation=++epoch.current;
   try {const profile=parseProfileDocument(json);const record=await saveProfile({profile,expectedRevision:selected?.id===profile.id?selected.revision:null});if(generation===epoch.current){setSelected(record);edit(copyProfile(record.profile));}}
   catch(e){if(generation===epoch.current)setError(String(e));}finally{lock.current=false;setBusy(false);}
 };
 const reload=async()=>{const generation=epoch.current;const id=selected?.id;if(!id)return;await refreshTaskProfiles();if(generation!==epoch.current)return;const current=useTaskProfileStore.getState().records.find(r=>r.id===id);if(!useTaskProfileStore.getState().error&&current)choose(current);};
 const apply=(text:string)=>{try{edit(parseProfileDocument(text));setError('');}catch(e){setError(String(e));}};
 const download=()=>{if(!draft)return;try{const profile=parseProfileDocument(json);const url=URL.createObjectURL(new Blob([JSON.stringify(profile,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`${profile.id.replace(/[^a-z0-9_-]/gi,'_')}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),0);}catch(e){setError(String(e));}};
 return <section className="task-surface" aria-label="Profile 库"><h2>验证 Profile 库</h2><p>配置只用于未来的任务计划；已接受任务保留冻结副本。保存不证明工具可用或 Provider 已认证。</p>
 {!isDesktopRuntime()&&<p>浏览器预览无法访问 Profile 库；任务仍可使用手动 JSON。</p>}
 {state.error&&<p role="status" className="task-error">{state.error}</p>}{error&&<p role="alert" className="task-error">{error}</p>}
 <div className="task-row"><button disabled={busy} onClick={()=>choose(null)}>新建 Profile</button><button disabled={busy||state.loading} onClick={()=>void refreshTaskProfiles()}>刷新 Profile 库</button></div>
 <ul>{state.records.map(r=><li key={r.id}><button disabled={busy} onClick={()=>choose(r)}>{r.profile.name}</button> · {r.id} · 修订 {r.revision}</li>)}</ul>
 {!state.loading&&!state.error&&!state.records.length&&<p>尚无保存的 Profile。可以先创建配置，再创建第一个任务。</p>}
 {draft&&<fieldset disabled={busy}><ProfileEditor profile={draft} onChange={edit}/>
  <details><summary>高级 Profile JSON</summary><label>高级 Profile JSON<textarea className="task-code" value={json} onChange={e=>{++epoch.current;setJson(e.target.value);}}/></label><button onClick={()=>apply(json)}>应用 JSON</button></details>
  <div className="task-row"><button disabled={!isDesktopRuntime()} onClick={()=>void save()}>保存 Profile</button><button onClick={download}>导出配置</button>
   {selected&&<><button onClick={()=>void reload()}>重新载入所选 Profile</button><button onClick={()=>{++epoch.current;setSelected(null);edit({...copyProfile(draft),id:`${draft.id.slice(0,59)}-copy`});setError('');}}>复制为新 Profile</button></>}
  </div></fieldset>}
 <label>导入 Profile JSON<textarea value={importText} onChange={e=>setImportText(e.target.value)}/></label><button disabled={busy} onClick={()=>{try{const p=parseProfileDocument(importText);++epoch.current;setSelected(null);edit(p);setError('');}catch(e){setError(String(e));}}}>导入配置</button>
 </section>;
}
