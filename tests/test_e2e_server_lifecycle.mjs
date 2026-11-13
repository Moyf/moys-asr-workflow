// Exercise real helper process ownership without Python packages or Chromium.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const helpers = new URL('./e2e/helpers.mjs', import.meta.url).href;

function fixture(server, harness, timeout = 15000, env = {}) {
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
    `], { cwd: directory, encoding: 'utf8', timeout,
      env: { ...process.env, ...env, MAW_E2E_PYTHON: process.execPath } });
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
    // Allow the helper's 30s startup deadline and 5s cleanup to report their
    // diagnostics, with room for the Windows Job supervisor to start.
    process.platform === 'win32' ? 45000 : 15000,
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

for (const override of [false, true]) {
  test(`blank server ${override ? 'overrides only child env' : 'inherits env by default'} without changing parent env`, () => {
    const inherited = { MAW_ENV_FILE: 'inherited-settings.conf', STICKER_DIR: 'inherited-stickers' };
    const selected = override ? { MAW_ENV_FILE: 'empty-settings.conf', STICKER_DIR: '' } : inherited;
    const result = fixture(
      `const http = require('node:http');
       const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
       http.createServer((req, res) => {
         res.setHeader('Content-Type', 'application/json');
         res.end(JSON.stringify({MAW_ENV_FILE:process.env.MAW_ENV_FILE, STICKER_DIR:process.env.STICKER_DIR,
           MAW_APP_DATA_ROOT:process.env.MAW_APP_DATA_ROOT}));
       }).listen(port, '127.0.0.1');`,
      `const before = {...process.env};
       const options = ${JSON.stringify(override ? {env:selected} : {})};
       const server = await startBlankServer(await findFreePort(), 'settings', options);
       try {
         const response = await fetch(server.url);
         assert.deepEqual(await response.json(), {...${JSON.stringify(selected)}, MAW_APP_DATA_ROOT:'settings'});
         assert.ok(Object.keys(process.env).length === Object.keys(before).length
           && Object.keys(before).every(key => process.env[key] === before[key]),
           'startBlankServer must not mutate parent env');
       } finally { await server.stop(); }
       assert.ok(server.proc.exitCode !== null || server.proc.signalCode !== null);
       await assert.rejects(fetch(server.url));`,
      15000,
      inherited,
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr.slice(-2000));
  });
}
