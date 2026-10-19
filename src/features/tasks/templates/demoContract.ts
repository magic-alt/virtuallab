import type { TaskVerificationProfile } from '@/types/tasks';

/** Reference source included in Task.goal; the materialized file still needs review. */
export function demoAcceptanceScript(directory: string): string {
  if (!/^virtuallab-examples\/task-ranking-[a-z0-9][a-z0-9-]{0,47}$/.test(directory)) {
    throw new Error('案例路径必须位于独立的 virtuallab-examples 子目录。');
  }
  return `import assert from 'node:assert/strict';
const { rankTasks } = await import('./rank-tasks.mjs');
assert.equal(typeof rankTasks, 'function', 'export rankTasks(tasks)');
const input = Object.freeze([
  {id:'low', priority:'low', done:false, title:'Keep extra fields'},
  {id:'closed-high', priority:'high', done:true},
  {id:'high-a', priority:'high', done:false},
  {id:'normal', priority:'normal', done:false},
  {id:'high-b', priority:'high', done:false},
  {id:'closed-low', priority:'low', done:true},
].map(item => Object.freeze(item)));
const before = JSON.stringify(input);
const result = rankTasks(input);
assert.ok(Array.isArray(result), 'return an array');
assert.notEqual(result, input, 'return a new array');
assert.deepEqual(result.map(item => item.id), ['high-a','high-b','normal','low','closed-high','closed-low']);
assert.deepEqual(result, ['high-a','high-b','normal','low','closed-high','closed-low'].map(id => input.find(item => item.id === id)), 'preserve all task fields');
assert.equal(JSON.stringify(input), before, 'do not mutate inputs');
assert.deepEqual(rankTasks([]), []);
const one = [{id:'one', priority:'normal', done:false}];
assert.deepEqual(rankTasks(one), one);
assert.notEqual(rankTasks(one), one);
for (const value of [null, undefined, 1, 'tasks', {}]) assert.throws(() => rankTasks(value), TypeError, 'reject non-arrays');
for (const value of [null, {}, {id:'',priority:'high',done:false}, {id:' ',priority:'high',done:false}, {id:1,priority:'high',done:false}, {id:'x',priority:'urgent',done:false}, {id:'x',priority:'high',done:'false'}, {id:'x',priority:'high'}]) assert.throws(() => rankTasks([value]), TypeError, 'reject invalid records');
assert.throws(() => rankTasks([{id:'x',priority:'high',done:false},{id:'x',priority:'low',done:true}]), TypeError, 'reject duplicate IDs');
assert.deepEqual(rankTasks([{id:'a',priority:'low',done:true},{id:'b',priority:'high',done:true}]).map(t=>t.id), ['b','a']);
console.log('PASS: task-ranking acceptance reference v1');`;
}

export function demoProfile(directory: string): TaskVerificationProfile {
  return {
    schemaVersion: 1,
    id: 'builtin-task-ranking-v1',
    name: '内置案例 · Node.js 单元测试 + 行为验收',
    description: '实际运行单元测试、验收文件和示例。验收参考源码保存在任务目标中；人工审查须核对实际脚本，检查通过不代替审查。',
    sourcePaths: [], outputPaths: [], toolchainPrograms: ['node'],
    gates: [
      { id: 'unit', label: 'Agent 编写的单元测试', kind: 'unit', required: true, approval: 'none',
        executor: { type: 'process', program: 'node', args: ['--test', `${directory}/rank-tasks.test.mjs`], cwd: 'workspace', timeoutMs: 30000 } },
      { id: 'contract', label: '行为验收参考脚本', kind: 'unit', required: true, approval: 'none',
        executor: { type: 'process', program: 'node', args: [`${directory}/acceptance.mjs`], cwd: 'workspace', timeoutMs: 30000 } },
      { id: 'example', label: '运行示例输出', kind: 'evidence', required: true, approval: 'none',
        executor: { type: 'process', program: 'node', args: [`${directory}/demo.mjs`], cwd: 'workspace', timeoutMs: 30000 } },
    ],
  };
}

export function demoGoal(directory: string): string {
  const acceptance = demoAcceptanceScript(directory);
  return `在 ${directory} 内从零实现一个可运行的任务优先级排序器。只使用 Node.js 内置模块和 .mjs 文件，不安装依赖，不修改已有工程代码、package.json、AGENTS.md 或其他目录。

交付文件：
- rank-tasks.mjs：导出 rankTasks(tasks)。
- rank-tasks.test.mjs：用 node:test 和 node:assert/strict 编写真实测试。
- demo.mjs：导入 rankTasks，运行至少六个混合样例并打印排序结果。
- acceptance.mjs：逐字保存下面提供的验收参考源码，不删除或弱化断言。
- SPEC.md、PLAN.md、REVIEW.md：分别记录合同、可执行步骤、测试命令/真实结果/自查结论和未解决的问题。不得伪造测试输出。

精确行为合同：
输入为对象数组；每个对象需要非空白字符串 id、priority（high / normal / low）、布尔值 done。id 不能重复。非法输入抛 TypeError。保留额外属性。返回新数组，不修改输入数组或其对象。未完成任务全部排在已完成任务前；两组内部按 high、normal、low 排序；优先级相同保持原始顺序。支持空数组和单项数组。

例：low(false), closed-high(true), high-a(false), normal(false), high-b(false), closed-low(true)，输出 id 顺序必须为 high-a, high-b, normal, low, closed-high, closed-low。

先写测试并观察 RED，再实现最小代码，再运行 GREEN 并自查。测试命令：node --test ${directory}/rank-tasks.test.mjs；示例命令：node ${directory}/demo.mjs。Native 还会运行 acceptance.mjs；该文件属于可修改的工程输入，人工审查必须将它与本任务合同中的参考源码核对，不能把退出码当作防篡改证明。不要请求额外的平台选择：这个案例已明确为 Node.js。遇到工具缺失或不理解的约束，如实报告；不得安装全局工具或通过削弱断言制造成功。

acceptance.mjs 的完整参考源码：
\`\`\`javascript
${acceptance}
\`\`\``;
}
