import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('terminal fixture waits for a descendant delayed beyond the old eight-second limit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vl terminal 中文 '));
  const pidFile = path.join(root, 'descendant.pid');
  const script = fileURLToPath(new URL('../src-tauri/test-fixtures/terminal-process.cjs', import.meta.url));
  const leader = spawn(process.execPath, [script, '--leader', pidFile, '9000'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  leader.stderr.on('data', chunk => { stderr += chunk; });
  const deadline = setTimeout(() => leader.kill(), 35000);
  try {
    const [code, signal] = await once(leader, 'exit');
    assert.equal(code, 0, `leader failed: signal=${signal}, stderr=${stderr}`);
    const pid = Number(await readFile(pidFile, 'utf8'));
    assert.ok(Number.isInteger(pid) && pid > 0);
    process.kill(pid, 0); // The descendant must outlive the leader.
  } finally {
    clearTimeout(deadline);
    if (leader.exitCode === null && leader.signalCode === null) leader.kill();
    // The delayed descendant may publish its PID after a failed leader exits.
    // Wait within the same fixture deadline so a red test also cleans up.
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        const pid = Number(await readFile(pidFile, 'utf8'));
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
          break;
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await rm(root, { recursive: true, force: true });
  }
});
