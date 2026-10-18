import { describe, expect, it } from 'vitest';
import { materializeTemplate } from './catalog';
import { validateTaskPlan } from '../model';
import { workflowStages } from './stages';
import { taskFixture, readinessFixture } from '../fixtures';

describe('task workflow contracts', () => {
  it('passes the existing plan/Profile validator with a full instance ID', () => {
    const draft = materializeTemplate('node-demo', {title:'',goal:'',scope:[],profile:null,autoCommit:false}, 'a2345678-1234-4123-8123-123456789012');
    expect(validateTaskPlan({repositoryRoot:'/repo',expectedHeadSha:'a'.repeat(40),tasks:[draft]})).toEqual([]);
    expect(draft.profile?.gates.some(gate => gate.executor.type === 'process' && gate.executor.args.includes('--eval'))).toBe(false);
    expect(draft.goal).toContain('acceptance.mjs 的完整参考源码');
  });
  it('does not upgrade a stale recorded acceptance', () => {
    const task = taskFixture({acceptance:{headSha:'sha',inputDigest:'i',profileDigest:'p',acceptedAtMs:1,acknowledgedWarnings:false}});
    expect(workflowStages(task, readinessFixture({acceptanceCurrent:false})).find(stage=>stage.id==='delivery')?.state).toBe('pending');
  });
});
