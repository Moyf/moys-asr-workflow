import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const driver = fileURLToPath(new URL('./fixtures/e2e-lifecycle-driver.mjs', import.meta.url));
const synthetic = fileURLToPath(new URL('./fixtures/e2e-process-tree.py', import.meta.url));
const alive = pid => {
  try {
    process.kill(pid, 0);
    // Linux can retain an already-exited orphan as a zombie until PID 1 reaps
    // it. It cannot execute or own a listening socket; do not count it as live.
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) return false;
    }
    return true;
  } catch { return false; }
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startBystander() {
  const proc = spawn(process.execPath, ['-e', `
    const server = require('node:http').createServer((req, res) => res.end('bystander'));
    server.listen(0, '127.0.0.1', () => process.send(server.address().port));
  `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  const port = await new Promise((resolve, reject) => {
    proc.once('message', resolve); proc.once('error', reject);
  });
  return { proc, port };
}

function killOwned(pid) {
  if (!alive(pid)) return;
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
  } else process.kill(pid, 'SIGKILL');
}

async function portFree(port) {
  // Windows can report a process gone before the kernel releases its sockets.
  // Require successful rebinding within a deadline, rather than at that instant.
  const deadline = Date.now() + 2000;
  for (;;) {
    const server = createServer();
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      await new Promise(resolve => server.close(resolve));
      return;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || Date.now() >= deadline) throw error;
      await delay(25);
    }
  }
}

async function runScenario(kind, scenario, action = 'stop') {
  const root = mkdtempSync(join(tmpdir(), 'maw-lifecycle-'));
  mkdirSync(join(root, 'server-editor'));
  copyFileSync(synthetic, join(root, 'server-editor', 'serve.py'));
  writeFileSync(join(root, 'scenario.txt'), scenario);
  const evidence = join(root, 'evidence');
  mkdirSync(evidence);
  const bystander = await startBystander();
  const child = spawn(process.execPath, [driver, kind, action], { cwd: root, env: {
    ...process.env, MAW_E2E_PYTHON: scenario === 'missing-command' ? join(root, 'missing-python')
      : process.env.MAW_E2E_PYTHON || 'python', MAW_SCROLL_EVIDENCE: evidence,
  }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let output = '';
  let message;
  let timedOut = false;
  const started = Date.now();
  child.stdout.on('data', b => { output += b; });
  child.stderr.on('data', b => { output += b; });
  child.on('message', value => {
    message = value;
    if (value.ready) {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else child.kill('SIGTERM');
    }
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const timer = setTimeout(() => {
    timedOut = true;
    try { killOwned(child.pid); } catch {}
  }, scenario === 'hang' ? 52000 : 15000);
  try {
    const result = await exited;
    assert.equal(timedOut, false, `driver exceeded deadline: ${output}`);
    if (scenario === 'ready' && action === 'stop') {
      assert.equal(result.code, 0, output);
      assert.equal(message?.stopped, true);
    } else if (scenario !== 'ready') {
      assert.equal(result.code, 1, output);
      assert.ok(message?.failure, output);
      if (scenario === 'hang') assert.match(message.failure, /did not/);
    } else if (action.startsWith('signal:')) {
      assert.equal(result.code, { SIGINT: 130, SIGTERM: 143, SIGBREAK: 149, SIGHUP: 129 }[action.slice(7)]);
    } else if (action === 'exit') assert.equal(result.code, 0, output);
    else if (action === 'exception') assert.equal(result.code, 1, output);
    assert.ok(Date.now() - started < (scenario === 'hang' ? 52000 : 15000));
    const dir = join(evidence, readdirSync(evidence)[0]);
    const { port } = JSON.parse(readFileSync(join(dir, 'runtime.json')));
    if (scenario !== 'missing-command') {
      const pids = JSON.parse(readFileSync(join(dir, 'owned-pids.json')));
      const deadline = Date.now() + 2000;
      while (pids.some(alive) && Date.now() < deadline) await delay(25);
      assert.deepEqual(pids.filter(alive), [], 'owned descendants must exit, not just the wrapper');
    }
    await portFree(port);
    assert.equal(alive(bystander.proc.pid), true, 'unrelated process must remain alive');
    const response = await fetch(`http://127.0.0.1:${bystander.port}`, { signal: AbortSignal.timeout(1000) });
    assert.equal(await response.text(), 'bystander');
  } finally {
    clearTimeout(timer);
    for (const name of readdirSync(evidence)) {
      try { for (const pid of JSON.parse(readFileSync(join(evidence, name, 'owned-pids.json')))) killOwned(pid); } catch {}
    }
    try { killOwned(child.pid); } catch {}
    bystander.proc.kill();
  }
}

for (const kind of ['scroll', 'helpers']) {
  for (const scenario of ['ready', 'startup-error', 'wrapper-exit', 'missing-command', 'hang']) {
    test(`${kind}: ${scenario} reaps descendants, frees port, and returns within deadline`,
      { timeout: 58000 }, () => runScenario(kind, scenario));
  }
  for (const action of ['exit', 'exception', 'signal:SIGINT', 'signal:SIGTERM',
    process.platform === 'win32' ? 'signal:SIGBREAK' : 'signal:SIGHUP', 'hold']) {
    // emit exercises the JS handler on Windows; process.kill(SIGTERM) there is
    // unconditional termination, not delivery of a catchable POSIX signal.
    test(`${kind}: ${action} cleans up after owner exit`, { timeout: 20000 },
      () => runScenario(kind, 'ready', action));
  }
}
