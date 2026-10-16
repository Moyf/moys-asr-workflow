import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnServerProcess, stopServerProcess, serverRequest, terminate } from './e2e/server-process.mjs';

test('managed command preserves argument boundaries and stdout/stderr', { timeout: 15000 }, async () => {
  const values = ['space here', '中文', 'quote"here', '', 'trailing\\', 'slash\\"quote', '$() & ; literal'];
  const child = spawnServerProcess(process.execPath, ['-e',
    'console.log(JSON.stringify(process.argv.slice(1))); console.error("stderr preserved");', '--', ...values]);
  let output = '', errorOutput = '';
  child.stdout.on('data', b => { output += b; });
  child.stderr.on('data', b => { errorOutput += b; });
  try {
    const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    assert.equal(code, 0, errorOutput);
    assert.deepEqual(JSON.parse(output.trim()), values);
    assert.match(errorOutput, /stderr preserved/);
  } finally { await stopServerProcess(child); }
});

test('readiness timeout includes a response body that never finishes', { timeout: 5000 }, async () => {
  const server = createServer((_req, res) => { res.writeHead(200); res.write('{'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(serverRequest(`http://127.0.0.1:${server.address().port}`, { json: true, timeout: 100 }),
      error => ['TimeoutError', 'AbortError'].includes(error.name));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('EPERM killing a POSIX process group falls back to the leader and records probe results',
  { skip: process.platform === 'win32', timeout: 5000 }, async () => {
    const pgid = 4242;
    const originalKill = process.kill;
    const originalWarn = console.warn;
    const warnings = [];
    let leaderKilled = false;
    process.kill = (pid, signal) => {
      if (pid === -pgid && signal === 'SIGKILL') {
        const error = new Error('permission denied');
        error.code = 'EPERM';
        throw error;
      }
      if (pid === -pgid && signal === 0) {
        const error = new Error('permission denied');
        error.code = 'EPERM';
        throw error;
      }
      return originalKill(pid, signal);
    };
    console.warn = message => warnings.push(message);
    try {
      await terminate({ closed: false, proc: { pid: pgid, exitCode: null, signalCode: null,
        kill: signal => { leaderKilled = signal === 'SIGKILL'; } } });
      assert.equal(leaderKilled, true);
      assert.equal(warnings.length, 2);
      assert.match(warnings[0], new RegExp(`process group kill EPERM \\(pgid=${pgid}\\), falling back to leader-only kill`));
      assert.match(warnings[1], new RegExp(`possible orphan process in group \\(pgid=${pgid}; attempt 1: alive \\(EPERM\\); attempt 2: alive \\(EPERM\\); attempt 3: alive \\(EPERM\\)\\)`));
    } finally {
      process.kill = originalKill;
      console.warn = originalWarn;
    }
  });
