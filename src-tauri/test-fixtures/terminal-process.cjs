// Disposable process tree for the inherited-PTY cleanup regression.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const pidFile = process.argv[3];

if (process.argv[2] === '--descendant') {
  setTimeout(() => {
    const pending = `${pidFile}.pending`;
    fs.writeFileSync(pending, String(process.pid));
    fs.renameSync(pending, pidFile);
    setInterval(() => {}, 1000);
    process.send({ ready: true });
  }, Number(process.argv[4] || 0));
} else {
  const child = spawn(process.execPath, [__filename, '--descendant', pidFile, process.argv[4] || '0'], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  const watchdog = setTimeout(() => {
    console.error('Descendant did not acknowledge startup within 30 seconds');
    child.kill();
    process.exitCode = 2;
  }, 30000);
  child.once('error', error => {
    clearTimeout(watchdog);
    console.error('Descendant spawn failed:', error);
    process.exitCode = 2;
  });
  child.once('exit', (code, signal) => {
    clearTimeout(watchdog);
    console.error(`Descendant exited before leader: code=${code}, signal=${signal}`);
    process.exitCode = 2;
  });
  child.once('message', message => {
    if (message.ready !== true) return;
    clearTimeout(watchdog);
    child.disconnect();
    process.exit(0);
  });
}
