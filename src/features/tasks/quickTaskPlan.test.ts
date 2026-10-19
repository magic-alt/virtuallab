import { describe, expect, it } from 'vitest';
import { validateTaskPlan } from './model';
import { quickTaskPlan } from './quickTaskPlan';

const create = (description:string, scopeText:string | null = null) => quickTaskPlan({
  repositoryRoot:'/repo', headSha:'b'.repeat(40), description, scopeText, profile:null, autoCommit:false,
});

describe('single-task prompt normalization', () => {
  it('preserves the complete user goal and derives a bounded Unicode title without invoking a planner', () => {
    const words='重构控制中心'.repeat(200);
    const plan=create('# ' + words + '\n支持回归测试');
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].goal).toContain('支持回归测试');
    expect(new TextEncoder().encode(plan.tasks[0].title).byteLength).toBeLessThanOrEqual(200);
    expect(plan.tasks[0].title.length).toBeGreaterThan(0);
    expect(plan.tasks[0].scope).toEqual(['.']);
    expect(validateTaskPlan(plan)).toEqual([]);
  });
  it('limits custom paths and never treats the whole-repository sentinel as a Profile path', () => {
    expect(create('测试', 'src/\ntests\\unit/').tasks[0].scope).toEqual(['src','tests/unit']);
    expect(validateTaskPlan(create('测试','../escape')).join()).toMatch(/范围/);
    expect(validateTaskPlan(create('测试','.env')).join()).toMatch(/范围/);
    expect(validateTaskPlan(create('测试','.\nsrc')).join()).toMatch(/范围/);
    expect(validateTaskPlan(create('测试','.'))).toEqual([]);
  });
  it('freezes the optional verified profile by value, not by a live library reference', () => {
    const profile={schemaVersion:1 as const,id:'unit',name:'Build test',gates:[{id:'u',label:'unit',kind:'unit' as const,required:true,approval:'none' as const,executor:{type:'process' as const,program:'npm',args:['test'],cwd:'workspace' as const}}]};
    const plan=quickTaskPlan({repositoryRoot:'/repo',headSha:'b'.repeat(40),description:'修复代码',scopeText:null,profile,autoCommit:false});
    profile.name='Changed outside';
    expect(plan.tasks[0].profile?.name).toBe('Build test');
    expect(validateTaskPlan(plan)).toEqual([]);
  });
});
