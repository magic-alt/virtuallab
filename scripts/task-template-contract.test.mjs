// Node-only imports live in a JS test, outside the browser TypeScript project.
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { expect, it } from 'vitest';

it('runs real Node acceptance assertions and launch/recovery regressions', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./check-task-templates.mjs', import.meta.url))], {encoding:'utf8',timeout:30000});
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toContain('focused core checks passed');
}, 40000);
