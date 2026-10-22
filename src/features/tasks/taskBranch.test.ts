import { describe, expect, it } from 'vitest';
import { suggestTaskBranch } from './taskBranch';

describe('task branch names', () => {
  it('keeps English and Chinese intent with a stable collision suffix', () => {
    expect(suggestTaskBranch('Fix Terminal startup', 'task-1')).toMatch(/^task\/fix-terminal-startup-[a-f0-9]{12}$/);
    expect(suggestTaskBranch('修复终端启动', 'task-1')).toMatch(/^task\/修复终端启动-[a-f0-9]{12}$/);
    expect(suggestTaskBranch('Fix Terminal startup', 'task-1')).toBe(suggestTaskBranch('Fix Terminal startup', 'task-1'));
    expect(suggestTaskBranch('Fix Terminal startup', 'task-2')).not.toBe(suggestTaskBranch('Fix Terminal startup', 'task-1'));
  });
  it('removes Git metacharacters and bounds UTF-8 paths without cutting a character', () => {
    const branch = suggestTaskBranch('  ../Fix\\Terminal @{bad}: [startup]? *.lock\n', 'task-1');
    expect(branch).toMatch(/^task\/fix-terminal-bad-startup-lock-[a-f0-9]{12}$/);
    const long = suggestTaskBranch('修复终端启动'.repeat(100), 'task-1');
    expect(new TextEncoder().encode(long).byteLength).toBeLessThanOrEqual(90);
    expect(long).not.toContain('\uFFFD');
    expect(suggestTaskBranch('🔥 ...', 'task-1')).toMatch(/^task\/work-[a-f0-9]{12}$/);
  });
});
