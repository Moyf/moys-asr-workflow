import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnServerProcess, stopServerProcess, serverRequest } from './e2e/server-process.mjs';

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
