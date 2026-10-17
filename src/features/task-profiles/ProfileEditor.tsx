import type {TaskVerificationProfile} from '@/types/tasks';
import type {VerificationGate} from '@/types/verification';
import {newProfile} from './profileModel';
interface Props {profile:TaskVerificationProfile;onChange:(profile:TaskVerificationProfile)=>void}
export function ProfileEditor({profile,onChange}:Props) {
 const update=(patch:Partial<TaskVerificationProfile>)=>onChange({...profile,...patch});
 const gateUpdate=(index:number,patch:Partial<VerificationGate>)=>update({gates:profile.gates.map((g,i)=>i===index?{...g,...patch}:g)});
 return <>
  <label>Profile ID<input value={profile.id} onChange={e=>update({id:e.target.value})}/></label>
  <label>Profile 名称<input value={profile.name} onChange={e=>update({name:e.target.value})}/></label>
  <label>说明<textarea value={profile.description??''} onChange={e=>update({description:e.target.value})}/></label>
  {(['sourcePaths','outputPaths','toolchainPrograms'] as const).map(key=><label key={key}>{key}（每行一个）<textarea value={(profile[key]??[]).join('\n')} onChange={e=>update({[key]:e.target.value.split('\n')})} onBlur={e=>update({[key]:e.target.value.split('\n').filter(Boolean)})}/></label>)}
  {profile.gates.map((gate,index)=>{
    const executor=gate.executor;const prefix=`Gate ${index+1}`;
    const execUpdate=(patch:Partial<typeof executor>)=>gateUpdate(index,{executor:{...executor,...patch} as VerificationGate['executor']});
    return <section key={index} className="task-node"><h3>{prefix}</h3>
     <label>{prefix} ID<input value={gate.id} onChange={e=>gateUpdate(index,{id:e.target.value})}/></label>
     <label>{prefix} 名称<input value={gate.label} onChange={e=>gateUpdate(index,{label:e.target.value})}/></label>
     <label>{prefix} 类型<select value={gate.kind} onChange={e=>gateUpdate(index,{kind:e.target.value as VerificationGate['kind']})}>{['build','unit','evidence','hil','hardware','soak'].map(k=><option key={k}>{k}</option>)}</select></label>
     <label className="task-checkbox"><input type="checkbox" checked={gate.required} onChange={e=>gateUpdate(index,{required:e.target.checked})}/>{prefix} 必需</label>
     <label>{prefix} 审批<select value={gate.approval} onChange={e=>gateUpdate(index,{approval:e.target.value as VerificationGate['approval']})}><option value="none">none</option><option value="human">human</option></select></label>
     {executor.type==='process'?<>
      <label>{prefix} 程序<select value={executor.program} onChange={e=>execUpdate({program:e.target.value})}>{Array.from(new Set([executor.program,'npm','cargo','cmake','ctest','ninja','node'])).map(p=><option key={p}>{p}</option>)}</select></label>
      <p>参数按行传递，不解析 shell 命令。</p>
      {executor.args.map((arg,i)=><div className="task-row" key={i}><label>{prefix} 参数 {i+1}<input value={arg} onChange={e=>execUpdate({args:executor.args.map((a,j)=>i===j?e.target.value:a)})}/></label><button onClick={()=>execUpdate({args:executor.args.filter((_,j)=>j!==i)})}>移除参数 {index+1}.{i+1}</button></div>)}
      <button onClick={()=>execUpdate({args:[...executor.args,'']})}>添加参数 {index+1}</button>
      <label>{prefix} 工作根<select value={executor.cwd} onChange={e=>execUpdate({cwd:e.target.value as 'workspace'|'repository'})}><option value="workspace">workspace</option><option value="repository">repository</option></select></label>
      <label>{prefix} 超时（毫秒）<input type="number" min={1} max={600000} value={executor.timeoutMs??''} onChange={e=>execUpdate({timeoutMs:e.target.value?Number(e.target.value):null})}/></label>
     </>:<p>Adapter 配置保留在高级 JSON；当前没有已资格验证的硬件执行器。</p>}
     {(executor.type==='adapter'||!['build','unit','evidence'].includes(gate.kind)||gate.approval!=='none')&&<p>此 Gate 尚不支持取得软件交付资格；保存配置不会授予执行权限。</p>}
     <button onClick={()=>update({gates:profile.gates.filter((_,i)=>i!==index)})}>移除 Gate {index+1}</button>
    </section>;
  })}
  <button disabled={profile.gates.length>=64} onClick={()=>update({gates:[...profile.gates,{...newProfile().gates[0],id:`gate-${profile.gates.length+1}`} ]})}>添加 Gate</button>
 </>;
}
