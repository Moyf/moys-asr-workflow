// Exercise real helper process ownership without Python packages or Chromium.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const helpers = new URL('./e2e/helpers.mjs', import.meta.url).href;

function fixture(server, harness) {
  const directory = mkdtempSync(join(tmpdir(), 'maw-helper-test-'));
  try {
    mkdirSync(join(directory, 'server-editor'));
    // The helper's Python override is a Node executable here; the fake .py
    // entrypoint contains JS so these process-contract tests need only Node.
    writeFileSync(join(directory, 'server-editor', 'serve.py'), server);
    return spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const { startBlankServer, findFreePort } = await import(${JSON.stringify(helpers)});
      ${harness}
    `], { cwd: directory, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, MAW_E2E_PYTHON: process.execPath } });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('startup failure returns a bounded final server diagnostic', () => {
  const result = fixture(
    "process.stdout.write('x'.repeat(2000000)); process.stdout.write('\\nERROR: fixture startup failed\\n'); process.exitCode = 3;",
    `try {
      await startBlankServer(await findFreePort(), 'settings');
      throw new Error('Unexpected startup success');
    } catch (error) {
      assert.ok(error.message.length < 4300);
      assert.match(error.message, /Server exited with code 3/);
      assert.match(error.message, /ERROR: fixture startup failed/);
    }`,
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr.slice(-2000));
});

test('ready server stop releases its process and descendant listening port', () => {
  const result = fixture(
    `const { spawn } = require('node:child_process');
     const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
     spawn(process.execPath, ['-e',
       "require('node:http').createServer((req, res) => res.end('ready')).listen(" + port + ", '127.0.0.1')"
     ], { stdio: 'inherit' });`,
    `const port = await findFreePort();
     const server = await startBlankServer(port, 'settings');
     await server.stop();
     assert.ok(server.proc.exitCode !== null || server.proc.signalCode !== null);
     await assert.rejects(fetch(server.url));`,
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr.slice(-2000));
});
