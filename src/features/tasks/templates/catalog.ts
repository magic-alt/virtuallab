import type { TaskDraft, TaskVerificationProfile } from '@/types/tasks';
import { demoGoal, demoProfile } from './demoContract';

export const WORKFLOW_SKILLS = [
  { id: 'intent', name: '目标澄清', trigger: '开始实现前', instruction: '从已接受的目标提取验收条件、约束和非目标；将事实与假设分开。已有明确要求不重复询问。' },
  { id: 'root-cause', name: '根因调查', trigger: '修复缺陷时', instruction: '先复现并记录预期/实际行为，再跟踪输入与状态边界。形成单一可检验假设，不叠加猜测性修复。' },
  { id: 'plan', name: '实施计划', trigger: '修改文件前', instruction: '按职责列出修改文件、接口、测试和验收命令；只在允许范围内写入计划。按独立可验证的步骤实施，避免额外重构。' },
  { id: 'tdd', name: '测试驱动实现', trigger: '实现和修复时', instruction: 'RED：先写回归测试并记录真实失败；GREEN：最小修改使其通过；REFACTOR：保留绿灯再整理代码。测试异常不等于有效的回归失败。' },
  { id: 'self-review', name: '规格与质量自查', trigger: '实现完成后', instruction: '分别检查规格符合性、边界条件、变更范围和代码质量。记录遗留问题。自查不是独立 Reviewer，也不能替代人工批准。' },
  { id: 'evidence', name: '证据交接', trigger: '返回完成结果前', instruction: '运行适用的测试，报告完整命令、退出码、通过/失败数量和未执行检查。Agent 的文字报告只是报告，Native 验证和人工审查决定交付。' },
] as const;
export type WorkflowSkillId = typeof WORKFLOW_SKILLS[number]['id'];
export type TaskTemplateId = 'feature' | 'bugfix' | 'build' | 'test' | 'ci' | 'docs' | 'node-demo';
export interface TaskTemplate {
  id: TaskTemplateId;
  version: 1;
  name: string;
  description: string;
  skills: readonly WorkflowSkillId[];
}
export const TASK_TEMPLATES: readonly TaskTemplate[] = [
  { id: 'feature', version: 1, name: '测试驱动功能开发', description: '目标 → 计划 → TDD → 自查 → 原生验证 → 人工交付。填写项目目标并选择已有验证 Profile。', skills: ['intent','plan','tdd','self-review','evidence'] },
  { id: 'bugfix', version: 1, name: '根因驱动缺陷修复', description: '复现 → 根因假设 → 回归测试 → 最小修复 → 验证；不把猜测当作定位结论。', skills: ['intent','root-cause','plan','tdd','self-review','evidence'] },
  { id: 'build', version: 1, name: '项目构建检查', description: '依据当前仓库的真实构建入口复现并修复构建问题。', skills: ['intent','root-cause','plan','self-review','evidence'] },
  { id: 'test', version: 1, name: '测试与回归检查', description: '使用项目现有测试入口，补齐明确的行为覆盖缺口。', skills: ['intent','plan','tdd','self-review','evidence'] },
  { id: 'ci', version: 1, name: '持续集成检查', description: '核对仓库 CI 配置与真实构建、类型检查和测试命令。', skills: ['intent','plan','self-review','evidence'] },
  { id: 'docs', version: 1, name: '项目文档核对', description: '对照当前代码与命令修正文档，保留未验证事项。', skills: ['intent','plan','self-review','evidence'] },
  { id: 'node-demo', version: 1, name: '可运行案例：任务优先级排序器', description: '可选的 Node.js 入门案例；在独立示例目录体验任务流程。', skills: ['intent','plan','tdd','self-review','evidence'] },
];
export interface TemplateInput {
  title: string;
  goal: string;
  scope: string[];
  profile: TaskVerificationProfile | null;
  autoCommit: boolean;
  autoDraftPr?: boolean;
  prBaseBranch?: string | null;
}

/** Materialize content, not execution state. Native owns persistence and every gate. */
export function materializeTemplate(templateId: string, input: TemplateInput, instanceId: string): TaskDraft {
  const template = TASK_TEMPLATES.find(item => item.id === templateId);
  if (!template) throw new Error('未知的任务流程模板。');
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(instanceId)) throw new Error('无效的案例实例标识。');
  const directory = `virtuallab-examples/task-ranking-${instanceId}`;
  const demo = template.id === 'node-demo';
  const instructions = template.skills.map((id, index) => {
    const skill = WORKFLOW_SKILLS.find(item => item.id === id)!;
    return `${index + 1}. ${skill.name}（${skill.trigger}）：${skill.instruction}`;
  }).join('\n');
  const goal = demo ? demoGoal(directory) : input.goal.trim();
  return {
    key: `${template.id}-${instanceId}`,
    title: demo ? `案例：任务优先级排序器 · ${instanceId}` : input.title.trim(),
    goal: `[VirtualLab workflow:${template.id}@1]\n${goal}\n\n执行方法（流程指导，不是独立 Agent 的执行证明）：\n${instructions}\n\n边界：遵守工作区安全规则，只修改 Task.scope 允许的路径。不要暂存、提交、推送、合并、发布或执行破坏性 Git 操作；本地封存只能由获得用户授权的 Native 完成。不要改变宿主的 Agent 权限。未验证就说未验证，不得声明人工审查或验收已经通过。`,
    scope: demo ? [directory] : [...input.scope],
    kind: 'implementation', dependencyKeys: [],
    profile: demo ? demoProfile(directory) : input.profile ? structuredClone(input.profile) : null,
    autoCommit: input.autoCommit,
    ...(input.autoDraftPr ? { autoDraftPr: true, prBaseBranch: input.prBaseBranch?.trim() || null } : {}),
  };
}

export function templateForGoal(goal: string): TaskTemplate | undefined {
  const id = /^\[VirtualLab workflow:([a-z-]+)@1\]\r?\n/.exec(goal)?.[1];
  return TASK_TEMPLATES.find(template => template.id === id);
}
