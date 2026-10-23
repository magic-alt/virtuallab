import type { DetectedTaskCheck, RepositoryTaskContext } from '@/lib/taskRecommendations';
import type { TaskProfileRecord } from '@/types/taskProfiles';
import type { TaskVerificationProfile } from '@/types/tasks';
import { materializeTemplate, type TaskTemplateId } from './catalog';
import { parseTaskProfile } from '../model';

export interface TaskRecommendation {
  id: string;
  repositoryRoot: string;
  templateId: TaskTemplateId;
  name: string;
  description: string;
  title: string;
  goal: string;
  scope: string[];
  commands: string[];
  profile: TaskVerificationProfile | null;
  profileSource: string;
  limitation: string | null;
}
const unique = (values: string[]) => [...new Set(values)];
const MAX_SCOPE_PATHS = 128;
const MAX_TASK_GOAL_BYTES = 8192;
const MAX_PATH_SUMMARY_BYTES = 1536;
const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).byteLength;

/** Summaries may shorten path text; the editable scope always retains complete paths. */
function summarizePaths(paths: string[]): { text: string; truncated: boolean } {
  const value = paths.join('、');
  if (byteLength(value) <= MAX_PATH_SUMMARY_BYTES) return { text: value, truncated: false };
  const budget = MAX_PATH_SUMMARY_BYTES - byteLength('…');
  let text = '';
  let bytes = 0;
  for (const character of value) {
    const size = byteLength(character);
    if (bytes + size > budget) break;
    text += character;
    bytes += size;
  }
  return { text: `${text}…`, truncated: true };
}

/** Reserve the actual workflow wrapper, whose instructions differ between templates. */
function recommendationGoalBudget(templateId: TaskTemplateId): number {
  const wrapper = materializeTemplate(templateId, { title: '', goal: '', scope: [], profile: null, autoCommit: false }, 'goal-budget');
  return MAX_TASK_GOAL_BYTES - byteLength(wrapper.goal);
}

const programKey = (program: string) => program.replace(/\.exe$/i, '').toLowerCase();
const commandKey = (command: { program: string; args: string[] }) => {
  const program = programKey(command.program);
  const args = program === 'npm' && command.args[0] === 'test' ? ['run', 'test', ...command.args.slice(1)] : command.args;
  return JSON.stringify([program, args]);
};

/** Display only; command strings are never parsed or sent to a shell. */
export function taskCommandLabel(command: { program: string; args: string[] }): string {
  return [command.program, ...command.args].map(part => /[\s"']/.test(part) ? JSON.stringify(part) : part).join(' ');
}

/** The global library has no repository binding. Recommend only independently matched facts. */
export function matchingRepositoryProfiles(context: RepositoryTaskContext, records: TaskProfileRecord[]): TaskProfileRecord[] {
  const commands = new Set(context.checks.map(commandKey));
  const paths = new Set(context.knownPaths);
  return records.filter(record => {
    try { parseTaskProfile(JSON.stringify(record.profile)); } catch { return false; }
    const profile = record.profile;
    return profile.gates.length > 0 && profile.gates.every(gate => gate.executor.type === 'process'
      && gate.executor.cwd === 'workspace' && gate.approval === 'none' && commands.has(commandKey(gate.executor)))
      && [...profile.sourcePaths ?? [], ...profile.outputPaths ?? []].every(path => paths.has(path))
      && (profile.toolchainPrograms ?? []).every(program => context.checks.some(check => programKey(check.program) === programKey(program)));
  });
}

function profileFor(id: string, name: string, checks: DetectedTaskCheck[], records: TaskProfileRecord[]) {
  if (!checks.length) return { profile: null, source: '未检测到适用的正式验证配置' };
  const wanted = new Set(checks.map(commandKey));
  const matching = records.find(record => record.profile.gates.every(gate => gate.executor.type === 'process' && wanted.has(commandKey(gate.executor)))
    && [...wanted].every(command => record.profile.gates.some(gate => gate.executor.type === 'process' && commandKey(gate.executor) === command)));
  if (matching) return { profile: structuredClone(matching.profile), source: `匹配已保存 Profile：${matching.profile.name} · 修订 ${matching.revision}` };
  const profile: TaskVerificationProfile = {
    schemaVersion: 1, id: `detected-${id.replace(/[^a-z0-9_-]/gi, '-').slice(0, 48)}`,
    name: `仓库检测 · ${name}`.slice(0, 120),
    description: '从当前仓库的实际命令复制。需要确认命令与修改范围；Native 在执行时验证环境和证据。',
    gates: checks.map((check, index) => ({
      id: `check-${index + 1}`, label: check.name, kind: check.kind, required: true, approval: 'none',
      executor: { type: 'process', program: check.program, args: [...check.args], cwd: 'workspace', timeoutMs: 600_000 },
    })),
  };
  return { profile, source: '从当前仓库检测到的命令生成，尚未运行验证' };
}

export function repositoryRecommendations(context: RepositoryTaskContext, records: TaskProfileRecord[]): TaskRecommendation[] {
  const matches = matchingRepositoryProfiles(context, records);
  const scope = unique([...context.sourcePaths, ...context.manifestPaths]);
  const checks = context.checks.filter(check => ['npm', 'cargo'].includes(programKey(check.program)));
  const recommendations: TaskRecommendation[] = [];
  const add = (value: { id: string; templateId: TaskTemplateId; name: string; title: string; description: string; instructions: string; scope: string[]; checks: DetectedTaskCheck[]; commands?: string[]; limitation?: string | null }) => {
    const selected = profileFor(value.id, value.name, value.checks, matches);
    const commands = value.commands ?? value.checks.map(taskCommandLabel);
    const allPaths = unique(value.scope);
    const selectedScope = allPaths.slice(0, MAX_SCOPE_PATHS);
    const paths = summarizePaths(selectedScope);
    const notices = [value.limitation ?? (!selected.profile ? '尚无可匹配的验证配置。可运行实施任务，结果将标记未验证；正式验证需要另行配置。' : null)];
    if (allPaths.length > MAX_SCOPE_PATHS) notices.push(`范围已截断为 ${MAX_SCOPE_PATHS} 个实际路径（检测到 ${allPaths.length} 个），请确认并缩小修改范围；未列出的路径不在授权范围内。`);
    if (!selectedScope.length) notices.push('未检测到可确认的范围，请填写实际修改范围。');
    if (paths.truncated) notices.push('目标中的路径摘要已截断，完整路径保留在修改范围，请确认并缩小范围。');
    let limitation = notices.filter(Boolean).join(' ') || null;
    const commandHeader = '实际检查命令（仓库根目录）：';
    const renderGoal = (commandText: string) => `${value.instructions}\n\n${paths.text ? `已检测到的相关路径${paths.truncated ? '（摘要）' : ''}：${paths.text}。` : '未检测到可确认的相关路径。'}\n${commandText}\n验收：说明实际修改、每个检查的结果和未解决问题；只修改已确认范围。${limitation ? `\n范围与验证说明：${limitation}` : ''}`;
    const commandLines = commands.map(command => `- ${command}`);
    let goal = renderGoal(commands.length ? `${commandHeader}\n${commandLines.join('\n')}` : '没有检测到可直接用于此任务的检查命令；先确认验证方法，不要宣称验证通过。');
    const goalBudget = recommendationGoalBudget(value.templateId);
    if (byteLength(goal) > goalBudget) {
      notices.push('实际命令较长，目标仅列出可容纳的完整命令；完整命令保留在推荐卡片中，执行前请核对。');
      limitation = notices.filter(Boolean).join(' ');
      const included: string[] = [];
      for (const line of commandLines) {
        if (byteLength(renderGoal(`${commandHeader}\n${[...included, line].join('\n')}`)) > goalBudget) break;
        included.push(line);
      }
      goal = renderGoal(`${commandHeader}\n${included.join('\n')}`);
    }
    recommendations.push({
      ...value, scope: selectedScope, repositoryRoot: context.repositoryRoot, commands, profile: selected.profile, profileSource: selected.source, limitation, goal,
    });
  };
  for (const recipe of context.recipes.filter(item => item.kind === 'build' || item.kind === 'package').slice(0, 8)) {
    const detected = recipe.steps.map(step => checks.find(check => commandKey(check) === commandKey(step)));
    const supportedChecks = recipe.supported && detected.every(Boolean) ? detected as DetectedTaskCheck[] : [];
    add({ id: `build-${recipe.id}`, templateId: 'build', name: `构建 · ${recipe.name}`, title: '检查并修复项目构建',
      description: `基于当前仓库 Run 配方：${recipe.description}`, scope,
      instructions: '复现当前项目的构建问题，定位失败原因，完成必要的最小修复，并运行项目现有构建流程。构建正常时记录结果，不做无关修改。',
      checks: supportedChecks, commands: recipe.steps.map(taskCommandLabel),
      limitation: !recipe.supported ? '当前平台不支持此 Run 配方；请在受支持的环境核验，不能将其当作正式验证通过。'
        : supportedChecks.length ? null : '此 Run 配方尚不能直接用于任务正式验证。CMake 需要已配置的 Ninja 构建与明确编译器；Keil 等工具须使用已有支持能力，不生成虚构 Profile。',
    });
  }
  for (const check of checks.filter(check => check.program === 'cargo' && check.args[0] === 'build')) {
    add({ id: check.id, templateId: 'build', name: `构建 · ${check.name}`, title: '检查并修复 Rust 构建', description: '检测到当前根目录 Cargo 清单。', scope, checks: [check], instructions: '复现当前 Rust 工程的构建问题，修复根因并保持公共接口兼容；构建正常时记录结果。' });
  }
  const unit = checks.filter(check => check.kind === 'unit');
  if (unit.length) add({ id: 'tests', templateId: 'test', name: '补齐测试与回归检查', title: '补齐测试与回归检查', description: '使用仓库已经声明的测试入口定位覆盖缺口并补充有意义的回归。', scope, checks: unit, instructions: '检查现有测试与实际行为，选择一个明确的边界条件或覆盖缺口，先展示有效失败，再完成最小实现或测试修复，最后执行现有测试入口。' });
  if (context.ciPaths.length) add({ id: 'ci', templateId: 'ci', name: '检查并改进 CI', title: '检查并改进持续集成检查', description: `已发现 ${context.ciPaths.join('、')}。`, scope: unique([...context.ciPaths, ...context.manifestPaths]), checks: checks.filter(check => !/docs|tauri/.test(check.id)), instructions: '检查当前持续集成配置与仓库实际构建、类型检查和测试命令是否一致，修复遗漏或失效的检查，保留现有触发和权限边界。执行本地等价命令并说明仍需 CI 环境确认的部分。' });
  if (context.documentationPaths.length) add({ id: 'docs', templateId: 'docs', name: '核对并完善项目文档', title: '核对并完善项目文档', description: `已发现 ${context.documentationPaths.join('、')}。`, scope: context.documentationPaths, checks: checks.filter(check => /docs/.test(check.id)), instructions: '对照当前代码和实际命令检查已有文档，修正安装、构建、测试和使用说明中的不一致；明确前提和未验证步骤，不虚构产品行为或成功结果。' });
  if (scope.length || context.recipes.length) add({ id: 'bugfix', templateId: 'bugfix', name: '定位并修复当前项目缺陷', title: '定位并修复项目缺陷', description: '按当前源码范围和实际验证入口开始根因调查；补充具体复现现象后执行。', scope, checks: unit.length ? unit : checks.filter(check => !/docs|tauri/.test(check.id)).slice(0, 3), instructions: '先在需求中补充具体复现步骤、实际行为和预期结果。复现后追踪状态与输入边界，形成一个可检验的根因假设；添加回归检查并完成最小修复。缺少复现信息时先调查并报告，不猜测缺陷。' });
  return recommendations;
}
