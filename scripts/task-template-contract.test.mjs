// Node-only imports live in a JS test, outside the browser TypeScript project.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('runs real Node acceptance assertions and launch/recovery regressions', () => {
  const result = spawnSync(process.execPath, [resolve(process.cwd(), 'scripts/check-task-templates.mjs')], {encoding:'utf8',timeout:30000});
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toContain('focused core checks passed');
}, 40000);
