// Run with: node scripts/check-task-templates.mjs
// Focused core contract checks; this does not replace npm test/typecheck/build.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = resolve(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'virtuallab-template-tests-'));
let checks = 0;
const check = async (name, run) => { await run(); ++checks; console.log(`PASS ${name}`); };
try {
  for (const name of ['demoContract', 'catalog', 'launch', 'stages']) {
    const source = readFileSync(join(root, `src/features/tasks/templates/${name}.ts`), 'utf8');
    const output = ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
    writeFileSync(join(temp, `${name}.mjs`), output.replaceAll("'./demoContract'", "'./demoContract.mjs'"));
  }
  const catalog = await import(pathToFileURL(join(temp,'catalog.mjs')).href);
  const demo = await import(pathToFileURL(join(temp,'demoContract.mjs')).href);
  const launch = await import(pathToFileURL(join(temp,'launch.mjs')).href);
  const stages = await import(pathToFileURL(join(temp,'stages.mjs')).href);
  await check('three discoverable workflow templates', () => assert.equal(catalog.TASK_TEMPLATES.length, 3));
  await check('every referenced skill exists', () => {
    for (const template of catalog.TASK_TEMPLATES) for(const id of template.skills) assert.ok(catalog.WORKFLOW_SKILLS.some(skill=>skill.id===id));
  });
  const input = {title:'Example', goal:'Implement the accepted requirement', scope:['src/example'],profile:null,autoCommit:false};
  const draft = catalog.materializeTemplate('node-demo',input,'case-123');
  await check('demo creates a bounded unique scope', () => assert.deepEqual(draft.scope,['virtuallab-examples/task-ranking-case-123']));
  await check('native text and profile budgets permit a full instance ID', () => {
    const longest=catalog.materializeTemplate('node-demo',input,'a2345678-1234-4123-8123-123456789012');
    assert.ok(Buffer.byteLength(longest.goal)<=8192, `Goal bytes ${Buffer.byteLength(longest.goal)}`);assert.ok(Buffer.byteLength(longest.title)<=256);assert.ok(Buffer.byteLength(JSON.stringify(longest.profile))<=65536);assert.ok(longest.key.length<=64);
  });
  await check('sealing remains explicit opt-in', () => assert.equal(draft.autoCommit,false));
  await check('fixture includes real verification gates', () => {
    assert.ok(draft.profile.gates.every(g=>g.required && g.executor.program==='node' && g.executor.cwd==='workspace'));
    assert.ok(draft.profile.gates.some(g=>g.id==='contract' && g.executor.args[0].endsWith('/acceptance.mjs')));
    for(const gate of draft.profile.gates) for(const arg of gate.executor.args) {assert.ok(!['--eval','-e','--input-type=module'].includes(arg));assert.ok(!/[\x00-\x1f]/.test(arg));assert.ok(Buffer.byteLength(arg)<=2048);}
  });
  await check('goals preserve ordered engineering guidance', () => {
    assert.ok(draft.goal.includes('RED'));assert.ok(draft.goal.includes('rankTasks'));assert.ok(draft.goal.includes('不要暂存'));
  });
  await check('unsafe example IDs cannot enter paths or code', () => {
    for(const id of ['../escape','a/b','x\";exit','', 'a'.repeat(90)]) assert.throws(()=>catalog.materializeTemplate('node-demo',input,id));
  });
  await check('unknown template cannot silently fall back', () => assert.throws(()=>catalog.materializeTemplate('missing',input,'case-123')));
  await check('materialization does not share profile arrays', () => {
    const other=catalog.materializeTemplate('node-demo',input,'case-123');
    other.profile.gates[0].executor.args.push('changed');assert.notDeepEqual(other.profile,draft.profile);
  });
  await check('configured user profile is snapshotted, not mutated', () => {
    const profile=structuredClone(draft.profile);
    const feature=catalog.materializeTemplate('feature',{...input,profile},'case-123');
    feature.profile.gates[0].executor.args.push('changed');assert.deepEqual(profile,draft.profile);
    assert.deepEqual(feature.scope,input.scope);
  });
  const testGate=draft.profile.gates.find(g=>g.id==='contract').executor;
  const fixtureRoot=join(temp,'fixture');
  const { mkdirSync } = await import('node:fs');
  const directory=join(fixtureRoot,draft.scope[0]);mkdirSync(directory,{recursive:true});
  writeFileSync(join(directory,'acceptance.mjs'),demo.demoAcceptanceScript(draft.scope[0]));
  const evaluate=(implementation)=>{
    writeFileSync(join(directory,'rank-tasks.mjs'),implementation);
    return spawnSync(process.execPath,testGate.args,{cwd:fixtureRoot,encoding:'utf8',timeout:10000});
  };
  await check('reference acceptance rejects missing implementation', () => {
    const result=spawnSync(process.execPath,testGate.args,{cwd:fixtureRoot,encoding:'utf8',timeout:10000});assert.notEqual(result.status,0);
  });
  await check('reference acceptance rejects constant output', () => assert.notEqual(evaluate('export const rankTasks = () => [];').status,0));
  // This oracle exists only in the test. The app ships a task, not the answer.
  const reference=`export function rankTasks(tasks){
    if(!Array.isArray(tasks)) throw new TypeError('array required');
    const weights={high:0,normal:1,low:2}; const ids=new Set();
    tasks.forEach(t=>{if(!t || typeof t.id!=='string'||!t.id.trim()||!Object.hasOwn(weights,t.priority)||typeof t.done!=='boolean'||ids.has(t.id))throw new TypeError('invalid');ids.add(t.id);});
    return [...tasks].sort((a,b)=>Number(a.done)-Number(b.done)||weights[a.priority]-weights[b.priority]);
  }`;
  await check('reference acceptance accepts a correct implementation', () => {
    const result=evaluate(reference);assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PASS/);
  });
  await check('reference acceptance rejects reversed priority', () => assert.notEqual(evaluate(reference.replace('high:0,normal:1,low:2','high:2,normal:1,low:0')).status,0));
  await check('reference acceptance rejects in-place mutation', () => assert.notEqual(evaluate(reference.replace('[...tasks].sort','tasks.sort')).status,0));
  await check('reference acceptance rejects accepting duplicates', () => assert.notEqual(evaluate(reference.replace('||ids.has(t.id)','')).status,0));
  await check('demo contract refuses path escape',()=>assert.throws(()=>demo.demoAcceptanceScript('../escape')));
  const plan={repositoryRoot:'/repo',expectedHeadSha:'a'.repeat(40),tasks:[draft]};
  const record={id:'task-1',repositoryRoot:'/repo',workspaceRoot:null,attempts:[],review:null,acceptance:null,profile:draft.profile};
  const setup=()=>{
    const calls=[];let alive=true;
    const ports={accept:async()=>{calls.push('accept');return [record];},prepare:async()=>{calls.push('prepare');return {...record,workspaceRoot:'/worktree'};},start:async()=>{calls.push('start');return {...record,workspaceRoot:'/worktree'};},canContinue:()=>alive,onCreated:()=>calls.push('created')};
    return {calls,ports,dispose:()=>{alive=false;}};
  };
  const options={run:true,branch:'task/demo-case-123',executablePath:null};
  await check('save-only never creates workspace or starts agent', async()=>{
    const env=setup();await launch.launchTemplate(plan,{...options,run:false},env.ports);assert.deepEqual(env.calls,['accept','created']);
  });
  await check('explicit launch preserves write order', async()=>{
    const env=setup();await launch.launchTemplate(plan,options,env.ports);assert.deepEqual(env.calls,['accept','created','prepare','start']);
  });
  await check('disposed dialog never sends a write', async()=>{
    const env=setup();env.dispose();await assert.rejects(launch.launchTemplate(plan,options,env.ports));assert.deepEqual(env.calls,[]);
  });
  await check('repository removal after acceptance stops the chain', async()=>{
    const env=setup();env.ports.onCreated=()=>{env.calls.push('created');env.dispose();};
    await assert.rejects(launch.launchTemplate(plan,options,env.ports));assert.deepEqual(env.calls,['accept','created']);
  });
  await check('unknown preparation result never starts or replays', async()=>{
    const env=setup();env.ports.prepare=async()=>{env.calls.push('prepare');throw new Error('uncertain');};
    await assert.rejects(launch.launchTemplate(plan,options,env.ports));assert.deepEqual(env.calls,['accept','created','prepare']);
  });
  await check('workspace binding must exist before execution', async()=>{
    const env=setup();env.ports.prepare=async()=>record;
    await assert.rejects(launch.launchTemplate(plan,options,env.ports));assert.ok(!env.calls.includes('start'));
  });
  await check('failure to start does not create another plan', async()=>{
    const env=setup();env.ports.start=async()=>{env.calls.push('start');throw new Error('auth unavailable');};
    await assert.rejects(launch.launchTemplate(plan,options,env.ports));assert.deepEqual(env.calls,['accept','created','prepare','start']);
  });
  await check('unbound acceptance cannot advance delivery',()=>{
    const result=stages.workflowStages({...record,acceptance:{acceptedAtMs:1}},undefined);
    assert.notEqual(result.find(s=>s.id==='delivery').state,'done');
  });
  await check('historical evidence is not current verification',()=>{
    const task={...record,attempts:[{state:'succeeded',phase:'verification',evidence:{status:'pass'}}]};
    assert.notEqual(stages.workflowStages(task,undefined).find(s=>s.id==='verify').state,'done');
  });
  await check('failed latest attempt is visible',()=>{
    const task={...record,workspaceRoot:'/worktree',attempts:[{state:'failed',phase:'implementation',evidence:null}]};
    assert.equal(stages.workflowStages(task,undefined).find(s=>s.id==='execute').state,'blocked');
  });
  await check('current native warning remains deliverable after acknowledged review',()=>{
    const task={...record,attempts:[{state:'succeeded',phase:'verification',evidence:{status:'warn'}}],review:{approved:true},acceptance:{acceptedAtMs:1}};
    const ready={status:'warning',blockers:[],warnings:['optional check'],reviewCurrent:true,acceptanceCurrent:true};
    assert.equal(stages.workflowStages(task,ready).find(s=>s.id==='delivery').state,'done');
  });
  console.log(`\n${checks} focused core checks passed.`);
} finally { rmSync(temp,{recursive:true,force:true}); }
