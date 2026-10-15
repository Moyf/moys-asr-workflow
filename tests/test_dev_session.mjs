import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { parseSessionArgs, resolveSession, runOnce, runSession } from '../scripts/dev-session.mjs';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.killed = false;
    this.killCalls = 0;
  }

  kill() {
    this.killCalls += 1;
    this.killed = true;
    this.exitCode = 0;
  }
}

function closeChild(child, code) {
  child.exitCode = code;
  child.emit('close', code);
}

function createHarness({ buildStatus = 0, buildError = null } = {}) {
  const calls = { build: [], watch: [], run: [] };
  const watcher = new FakeChild();
  const runChild = new FakeChild();
  const exitCodes = [];
  const logs = [];
  const spawnFn = (command, args) => {
    if (command === 'uv') {
      calls.run.push({ command, args });
      return runChild;
    }
    if (args.includes('--watch')) {
      calls.watch.push({ command, args });
      return watcher;
    }
    calls.build.push({ command, args });
    throw new Error('unexpected non-watch node spawn routed to spawnFn');
  };
  const spawnSyncFn = (command, args) => {
    calls.build.push({ command, args });
    return { status: buildStatus, error: buildError };
  };
  const deps = {
    spawn: spawnFn,
    spawnSync: spawnSyncFn,
    exit: (code) => exitCodes.push(code),
    write: (line) => logs.push(line),
    writeError: (line) => logs.push(line),
  };
  return { calls, watcher, runChild, exitCodes, logs, deps };
}

test('resolveSession 编辑器默认空白启动', () => {
  const session = resolveSession('editor');
  assert.deepEqual(session.buildArgs, ['scripts/build-editor.mjs', '--write']);
  assert.deepEqual(session.watchArgs, ['scripts/build-editor.mjs', '--watch']);
  assert.equal(session.runCommand, 'uv');
  assert.deepEqual(session.runArgs, ['run', '--no-sync', 'python', 'server-editor/serve.py', '--blank']);
});

test('resolveSession 编辑器透传参数时不再追加 --blank', () => {
  const session = resolveSession('editor', ['project with spaces.mosp', '--port', '8251', '--no-open']);
  assert.deepEqual(session.runArgs, [
    'run', '--no-sync', 'python', 'server-editor/serve.py',
    'project with spaces.mosp', '--port', '8251', '--no-open',
  ]);
});

test('resolveSession launcher 默认带 --debug 启动 GUI', () => {
  const session = resolveSession('launcher');
  assert.deepEqual(session.buildArgs, ['scripts/build-launcher.mjs', '--write']);
  assert.deepEqual(session.watchArgs, ['scripts/build-launcher.mjs', '--watch']);
  assert.deepEqual(session.runArgs, ['run', '--no-sync', 'python', 'maw_gui.py', '--debug']);
});

test('resolveSession 未知目标抛错并列出可选项', () => {
  assert.throws(() => resolveSession('nope'), /editor、launcher/);
});

test('runSession 成功路径：先构建，再挂 watcher，最后运行 Python 入口', () => {
  const harness = createHarness();
  const session = runSession('editor', [], harness.deps);
  assert.ok(session);
  assert.equal(harness.calls.build.length, 1);
  assert.equal(harness.calls.watch.length, 1);
  assert.equal(harness.calls.run.length, 1);
  assert.deepEqual(harness.calls.build[0].args, ['scripts/build-editor.mjs', '--write']);
  assert.deepEqual(harness.calls.watch[0].args, ['scripts/build-editor.mjs', '--watch']);
  assert.equal(harness.calls.run[0].command, 'uv');
  assert.deepEqual(harness.calls.run[0].args, ['run', '--no-sync', 'python', 'server-editor/serve.py', '--blank']);

  closeChild(harness.runChild, 0);
  assert.deepEqual(harness.exitCodes, [0]);
  assert.equal(harness.watcher.killCalls, 1);
  assert.equal(harness.runChild.killCalls, 0);
});

test('runSession 构建失败立即退出，不启动 watcher 与 Python 入口', () => {
  const harness = createHarness({ buildStatus: 7 });
  runSession('editor', [], harness.deps);
  assert.deepEqual(harness.exitCodes, [7]);
  assert.equal(harness.calls.watch.length, 0);
  assert.equal(harness.calls.run.length, 0);
  assert.ok(harness.logs.some((line) => line.includes('构建失败')));
});

test('runSession 构建进程无法启动时按失败处理', () => {
  const harness = createHarness({ buildError: new Error('spawn ENOENT') });
  runSession('launcher', [], harness.deps);
  assert.deepEqual(harness.exitCodes, [1]);
  assert.equal(harness.calls.watch.length, 0);
  assert.equal(harness.calls.run.length, 0);
});

test('runSession Python 入口非零退出时回收 watcher 并透传退出码', () => {
  const harness = createHarness();
  runSession('editor', [], harness.deps);
  closeChild(harness.runChild, 7);
  assert.deepEqual(harness.exitCodes, [7]);
  assert.equal(harness.watcher.killCalls, 1);
});

test('runSession Python 入口无法启动时报错并回收 watcher', () => {
  const harness = createHarness();
  runSession('launcher', [], harness.deps);
  harness.runChild.emit('error', new Error('uv not found'));
  assert.deepEqual(harness.exitCodes, [1]);
  assert.equal(harness.watcher.killCalls, 1);
});

test('runSession 收到 SIGINT 时清理两个子进程', () => {
  const harness = createHarness();
  runSession('editor', [], harness.deps);
  process.emit('SIGINT');
  assert.deepEqual(harness.exitCodes, [0]);
  assert.equal(harness.watcher.killCalls, 1);
  assert.equal(harness.runChild.killCalls, 1);
});

test('runSession 未知目标直接以退出码 2 结束', () => {
  const harness = createHarness();
  runSession('nope', [], harness.deps);
  assert.deepEqual(harness.exitCodes, [2]);
  assert.equal(harness.calls.build.length, 0);
  assert.ok(harness.logs.some((line) => line.includes('未知的开发目标')));
});

test('parseSessionArgs 区分 --once 与透传参数', () => {
  assert.deepEqual(parseSessionArgs(['editor']), { target: 'editor', once: false, forwardedArgs: [] });
  assert.deepEqual(parseSessionArgs(['editor', '--once']), { target: 'editor', once: true, forwardedArgs: [] });
  assert.deepEqual(parseSessionArgs(['launcher', '--once', 'a.mosp', '--port', '1']), {
    target: 'launcher', once: true, forwardedArgs: ['a.mosp', '--port', '1'],
  });
  assert.deepEqual(parseSessionArgs(['editor', 'a.mosp']), {
    target: 'editor', once: false, forwardedArgs: ['a.mosp'],
  });
});

test('parseSessionArgs 兼容 pnpm 原样透传的前导 --', () => {
  assert.deepEqual(parseSessionArgs(['editor', '--', '--help']), {
    target: 'editor', once: false, forwardedArgs: ['--help'],
  });
  assert.deepEqual(parseSessionArgs(['editor', '--once', '--', '--help']), {
    target: 'editor', once: true, forwardedArgs: ['--help'],
  });
  assert.deepEqual(parseSessionArgs(['editor', '--', '--once', 'a.mosp', '--port', '1']), {
    target: 'editor', once: true, forwardedArgs: ['a.mosp', '--port', '1'],
  });
  assert.deepEqual(parseSessionArgs(['editor', '--', 'a.mosp', '--port', '1']), {
    target: 'editor', once: false, forwardedArgs: ['a.mosp', '--port', '1'],
  });
});

test('runOnce 构建后运行 Python 入口并透传退出码，不挂 watcher', () => {
  const harness = createHarness();
  const session = runOnce('editor', ['project.mosp'], harness.deps);
  assert.ok(session);
  assert.equal(harness.calls.watch.length, 0);
  assert.deepEqual(harness.calls.run[0].args, [
    'run', '--no-sync', 'python', 'server-editor/serve.py', 'project.mosp',
  ]);
  closeChild(harness.runChild, 0);
  assert.deepEqual(harness.exitCodes, [0]);
});

test('runOnce 构建失败立即退出，不运行 Python 入口', () => {
  const harness = createHarness({ buildStatus: 5 });
  runOnce('launcher', [], harness.deps);
  assert.deepEqual(harness.exitCodes, [5]);
  assert.equal(harness.calls.run.length, 0);
});

test('runOnce Python 入口非零退出时透传退出码', () => {
  const harness = createHarness();
  runOnce('editor', [], harness.deps);
  closeChild(harness.runChild, 9);
  assert.deepEqual(harness.exitCodes, [9]);
});

test('runOnce Python 入口无法启动时以 1 退出', () => {
  const harness = createHarness();
  runOnce('editor', [], harness.deps);
  harness.runChild.emit('error', new Error('uv missing'));
  assert.deepEqual(harness.exitCodes, [1]);
});

test('runOnce 未知目标以 2 退出', () => {
  const harness = createHarness();
  runOnce('nope', [], harness.deps);
  assert.deepEqual(harness.exitCodes, [2]);
});
