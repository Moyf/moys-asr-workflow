import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  appendBoundedOutput,
  childExited,
  parseBackendReadyLine,
  terminateBackendTree,
  waitForBackendReady,
} from '../src/backend_runtime.cjs';

class FakeStream extends EventEmitter {
  setEncoding(encoding) {
    this.encoding = encoding;
  }
}

class FakeChild extends EventEmitter {
  constructor(pid = 42) {
    super();
    this.pid = pid;
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
  }

  kill(signal = 'SIGTERM') {
    this.killed = true;
    this.signalCode = signal;
    this.emit('exit', null, signal);
    return true;
  }
}

test('parseBackendReadyLine accepts only a loopback port record', () => {
  assert.equal(parseBackendReadyLine('[serve] starting'), null);
  assert.deepEqual(
    parseBackendReadyLine('MAW_DESKTOP_READY {"host":"127.0.0.1","port":43123}'),
    { host: '127.0.0.1', port: 43123 },
  );
  assert.throws(
    () => parseBackendReadyLine('MAW_DESKTOP_READY {"host":"localhost","port":43123}'),
    /无效的监听地址/u,
  );
  assert.throws(
    () => parseBackendReadyLine('MAW_DESKTOP_READY {"port":43123}'),
    /无效的监听地址/u,
  );
  assert.throws(
    () => parseBackendReadyLine('MAW_DESKTOP_READY {"host":"127.0.0.1","port":"43123"}'),
    /无效的监听地址/u,
  );
  assert.throws(
    () => parseBackendReadyLine('MAW_DESKTOP_READY {"host":"127.0.0.1","port":0}'),
    /无效的监听地址/u,
  );
  assert.throws(
    () => parseBackendReadyLine('MAW_DESKTOP_READY nope'),
    /启动标记无效/u,
  );
});

test('waitForBackendReady handles chunked stdout and forwards diagnostics', async () => {
  const child = new FakeChild();
  const output = [];
  const ready = waitForBackendReady(child, {
    timeoutMs: 100,
    onOutput: (chunk) => output.push(chunk),
  });
  child.stdout.emit('data', '[serve] loading\nMAW_DESKTOP_');
  child.stdout.emit('data', 'READY {"host":"127.0.0.1","port":43210}\n');
  assert.deepEqual(await ready, { host: '127.0.0.1', port: 43210 });
  assert.deepEqual(output, [
    '[serve] loading\nMAW_DESKTOP_',
    'READY {"host":"127.0.0.1","port":43210}\n',
  ]);
});

test('waitForBackendReady rejects early process exit and timeout', async () => {
  const exited = new FakeChild();
  const exitedPromise = waitForBackendReady(exited, { timeoutMs: 100 });
  exited.exitCode = 7;
  exited.emit('exit', 7, null);
  await assert.rejects(exitedPromise, /提前退出/u);

  const timedOut = new FakeChild();
  await assert.rejects(
    waitForBackendReady(timedOut, { timeoutMs: 5 }),
    /启动超时/u,
  );

  const alreadyExited = new FakeChild();
  alreadyExited.exitCode = 3;
  await assert.rejects(
    waitForBackendReady(alreadyExited, { timeoutMs: 100 }),
    /提前退出/u,
  );
});

test('terminateBackendTree uses the verified root PID and descendant flag on Windows', async () => {
  const calls = [];
  const child = new FakeChild(9876);
  const result = await terminateBackendTree(child, {
    platform: 'win32',
    execFileImpl: (file, args, options, callback) => {
      calls.push({ file, args, options });
      callback(null);
    },
  });
  assert.equal(result, true);
  assert.deepEqual(calls, [{
    file: 'taskkill',
    args: ['/PID', '9876', '/T', '/F'],
    options: { windowsHide: true },
  }]);
  assert.equal(child.killed, false);
});

test('terminateBackendTree reports a taskkill failure without discovering another process', async () => {
  const calls = [];
  const child = new FakeChild(9877);
  const result = await terminateBackendTree(child, {
    platform: 'win32',
    execFileImpl: (file, args, options, callback) => {
      calls.push({ file, args, options });
      callback(new Error('taskkill failed'));
    },
  });
  assert.equal(result, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['/PID', '9877', '/T', '/F']);
  assert.equal(child.killed, false);
});

test('terminateBackendTree skips a child that already exited to avoid PID reuse', async () => {
  const calls = [];
  const child = new FakeChild(9878);
  child.exitCode = 0;
  const result = await terminateBackendTree(child, {
    platform: 'win32',
    execFileImpl: (...args) => calls.push(args),
  });
  assert.equal(result, false);
  assert.deepEqual(calls, []);
});

test('terminateBackendTree only signals a supplied non-Windows child', async () => {
  const child = new FakeChild(1234);
  assert.equal(await terminateBackendTree(child, { platform: 'linux' }), true);
  assert.equal(child.killed, true);
  assert.equal(child.signalCode, 'SIGTERM');
  assert.equal(childExited(child), true);
});

test('appendBoundedOutput retains only the newest diagnostics', () => {
  const state = { output: '' };
  appendBoundedOutput(state, 'abcdef', 4);
  assert.equal(state.output, 'cdef');
  appendBoundedOutput(state, 'XY', 4);
  assert.equal(state.output, 'efXY');
});
