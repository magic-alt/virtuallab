import { describe, expect, it } from 'vitest';
import { matchingRepositoryProfiles, repositoryRecommendations } from './repositoryRecommendations';
import type { RepositoryTaskContext } from '@/lib/taskRecommendations';
import type { TaskProfileRecord } from '@/types/taskProfiles';
import { materializeTemplate } from './catalog';
import { validateTaskPlan } from '../model';

const context: RepositoryTaskContext = {
  repositoryRoot: '/selected', recipes: [],
  checks: [{ id: 'npm-test', name: 'test', kind: 'unit', program: 'npm', args: ['run', 'test'] }],
  sourcePaths: ['src'], manifestPaths: ['package.json'], documentationPaths: ['docs'], ciPaths: [], knownPaths: ['src', 'package.json', 'docs'], warnings: [],
};
const saved = (id: string, args: string[], sourcePaths: string[] = []): TaskProfileRecord => ({ id, revision: 3, updatedAtMs: 1, profile: {
  schemaVersion: 1, id, name: `Saved ${id}`, sourcePaths,
  gates: [{ id: 'check', label: 'Test', kind: 'unit', required: true, approval: 'none', executor: { type: 'process', program: 'npm', args, cwd: 'workspace' } }],
} });
describe('repository recommendation evidence', () => {
  it('matches the npm test alias to an actual test script and copies the saved revision', () => {
    const profile = saved('actual-test', ['test'], ['src']);
    expect(matchingRepositoryProfiles(context, [profile])).toEqual([profile]);
    const recommendation = repositoryRecommendations(context, [profile]).find(item => item.id === 'tests')!;
    expect(recommendation.profile).toEqual(profile.profile);
    expect(recommendation.profileSource).toContain('修订 3');
    profile.profile.name = 'Later library revision';
    expect(recommendation.profile?.name).toBe('Saved actual-test');
  });
  it('does not recommend unrelated commands or another repository source paths', () => {
    const foreignCommand = saved('foreign-command', ['run', 'test:other']);
    const foreignScope = saved('foreign-scope', ['run', 'test'], ['other-project/src']);
    const foreignTool = saved('foreign-tool', ['run', 'test']); foreignTool.profile.toolchainPrograms = ['/other/project/bin/tool'];
    expect(matchingRepositoryProfiles(context, [foreignCommand, foreignScope, foreignTool])).toEqual([]);
    const recommendation = repositoryRecommendations(context, [foreignCommand, foreignScope, foreignTool]).find(item => item.id === 'tests')!;
    expect(recommendation.profile?.id).toBe('detected-tests');
    expect(recommendation.goal).not.toContain('other-project');
  });
  it('leaves documentation unverified without inventing a docs script or CI workflow', () => {
    const recommendations = repositoryRecommendations(context, []);
    expect(recommendations.some(item => item.templateId === 'ci')).toBe(false);
    const docs = recommendations.find(item => item.templateId === 'docs')!;
    expect(docs.scope).toEqual(['docs']); expect(docs.commands).toEqual([]); expect(docs.profile).toBeNull();
    expect(docs.goal).toContain('没有检测到');
  });

  it('limits flat repository scopes to actual paths with an explicit truncation notice', () => {
    const paths = Array.from({ length: 129 }, (_, index) => `source-${index}.cpp`);
    const large = { ...context, sourcePaths: paths, manifestPaths: ['CMakeLists.txt'], documentationPaths: [] };
    for (const recommendation of repositoryRecommendations(large, [])) {
      expect(recommendation.scope).toHaveLength(128);
      expect(recommendation.scope.every(path => [...paths, 'CMakeLists.txt'].includes(path))).toBe(true);
      expect(recommendation.scope).not.toContain('.');
      expect(recommendation.limitation).toMatch(/截断.*128/);
      expect(recommendation.limitation).toContain('确认并缩小');
      const draft = materializeTemplate(recommendation.templateId, { ...recommendation, autoCommit: false }, 'scope-limit');
      expect(validateTaskPlan({ repositoryRoot: context.repositoryRoot, expectedHeadSha: 'a'.repeat(40), tasks: [draft] })).toEqual([]);
    }
  });

  it('keeps complete Unicode scope paths while budgeting the wrapped task goal in UTF-8', () => {
    const paths = Array.from({ length: 128 }, (_, index) => `目录/${'工程'.repeat(90)}/源文件-${index}.cpp`);
    const large = { ...context, sourcePaths: paths, manifestPaths: [], documentationPaths: [] };
    const encoder = new TextEncoder();
    for (const recommendation of repositoryRecommendations(large, [])) {
      expect(recommendation.scope).toEqual(paths);
      const draft = materializeTemplate(recommendation.templateId, { ...recommendation, autoCommit: false }, 'utf8-limit');
      expect(encoder.encode(draft.goal).byteLength).toBeLessThanOrEqual(8192);
      expect(recommendation.goal).toContain('目录/工程');
      expect(recommendation.goal).toContain('摘要');
      expect(recommendation.goal).toContain('完整路径保留在修改范围');
      expect(recommendation.goal).toContain('npm run test');
      expect(recommendation.goal).not.toContain('\uFFFD');
    }
  });

  it('requires explicit scope entry when a recipe has no detected source paths', () => {
    const empty = { ...context, sourcePaths: [], manifestPaths: [], documentationPaths: [], checks: [], recipes: [{
      id: 'cmake-configure-build', name: 'CMake', kind: 'build' as const, tool: 'CMake', description: '', supported: true,
      steps: [{ name: 'Compile', program: 'cmake', args: ['--build', 'build'] }],
    }] };
    for (const recommendation of repositoryRecommendations(empty, [])) {
      expect(recommendation.scope).toEqual([]);
      expect(recommendation.limitation).toContain('填写实际修改范围');
    }
  });
});
