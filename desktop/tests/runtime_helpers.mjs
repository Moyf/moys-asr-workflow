import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';

import {
  PROJECT_EXTENSIONS,
  buildServeArgs,
  createProjectMessageQueue,
  isProjectPath,
  parseProjectArgs,
  resolvePackagedMawPath,
  resolveSourcePython,
  showAndFocusWindow,
} from '../src/runtime_helpers.cjs';

test('project argument parsing accepts .mosp and legacy .json only', () => {
  assert.deepEqual(PROJECT_EXTENSIONS, new Set(['.mosp', '.json']));
  assert.equal(isProjectPath('clip.mosp'), true);
  assert.equal(isProjectPath('clip.JSON'), true);
  assert.equal(isProjectPath('clip.srt'), false);
  assert.equal(isProjectPath('--desktop-mode'), false);
});

test('parseProjectArgs resolves relative paths from the supplied cwd', () => {
  const cwd = path.win32.join('C:', 'work');
  assert.equal(
    parseProjectArgs(['--flag', path.win32.join('projects', 'clip.mosp')], cwd),
    path.resolve(cwd, 'projects', 'clip.mosp'),
  );
});

test('parseProjectArgs keeps a missing associated project for the editor to report', () => {
  const missing = path.resolve('missing-project.mosp');
  assert.equal(parseProjectArgs([missing]), missing);
});

test('resolvePackagedMawPath locates the sibling MAW executable', () => {
  const executable = path.win32.resolve('suite', 'MAW', 'MOSE', 'MOSE.exe');
  assert.equal(
    resolvePackagedMawPath(executable, { platform: 'win32' }),
    path.win32.resolve('suite', 'MAW', 'MAW.exe'),
  );
});

test('showAndFocusWindow restores and reveals a hidden minimized window', () => {
  const calls = [];
  const window = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push('restore'),
    isVisible: () => false,
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  };

  assert.equal(showAndFocusWindow(window), true);
  assert.deepEqual(calls, ['restore', 'show', 'focus']);
});

test('showAndFocusWindow ignores a destroyed window', () => {
  let called = false;
  const window = {
    isDestroyed: () => true,
    isMinimized: () => { called = true; return false; },
    restore: () => { called = true; },
    isVisible: () => { called = true; return false; },
    show: () => { called = true; },
    focus: () => { called = true; },
  };

  assert.equal(showAndFocusWindow(window), false);
  assert.equal(called, false);
});

test('native packages use their own resources backend, including paths with spaces', () => {
  assert.equal(resolvePackagedMawPath('/Applications/MOSE.app/Contents/MacOS/MOSE', {
    platform: 'darwin', resourcesPath: '/Applications/MOSE.app/Contents/Resources',
  }), '/Applications/MOSE.app/Contents/Resources/backend/MAW.app/Contents/MacOS/MAW');
  assert.equal(resolvePackagedMawPath('/tmp/MOSE mount/mose', {
    platform: 'linux', resourcesPath: '/tmp/MOSE mount/resources',
  }), '/tmp/MOSE mount/resources/backend/MAW/MAW');
  assert.throws(() => resolvePackagedMawPath('/opt/MOSE/mose', { platform: 'linux' }), /resourcesPath/);
});

test('resolveSourcePython prefers an explicit override, then the repository venv', () => {
  const root = path.resolve('checkout');
  const venv = path.join(root, '.venv', 'Scripts', 'python.exe');
  const exists = (candidate) => candidate === venv;
  assert.equal(
    resolveSourcePython(root, {
      platform: 'win32',
      environment: { MAW_MOSE_PYTHON: 'custom-python', PYTHON: 'path-python' },
      exists,
    }),
    'custom-python',
  );
  assert.equal(
    resolveSourcePython(root, {
      platform: 'win32',
      environment: { PYTHON: 'path-python' },
      exists,
    }),
    venv,
  );
  assert.equal(
    resolveSourcePython(root, {
      platform: 'win32',
      environment: {},
      exists: () => false,
    }),
    'python',
  );
});

test('buildServeArgs uses the public MAW server switch in packaged mode', () => {
  assert.deepEqual(
    buildServeArgs('C:\\Projects\\clip.mosp', { packaged: true }),
    ['--server', 'C:\\Projects\\clip.mosp', '--port', '0', '--no-open', '--desktop-mode'],
  );
});

test('buildServeArgs invokes server-editor directly in source mode', () => {
  assert.deepEqual(
    buildServeArgs(null, { serverPath: 'server-editor/serve.py' }),
    ['server-editor/serve.py', '--port', '0', '--no-open', '--desktop-mode'],
  );
});

test('createProjectMessageQueue waits for renderer readiness and keeps the newest path', () => {
  const sent = [];
  const queue = createProjectMessageQueue((projectPath) => sent.push(projectPath));

  assert.equal(queue.enqueue('first.mosp'), false);
  assert.equal(queue.enqueue('second.mosp'), false);
  assert.equal(queue.pendingPath(), 'second.mosp');
  assert.deepEqual(sent, []);

  assert.equal(queue.markReady(), true);
  assert.deepEqual(sent, ['second.mosp']);
  assert.equal(queue.pendingPath(), null);
  assert.equal(queue.enqueue('third.mosp'), true);
  assert.deepEqual(sent, ['second.mosp', 'third.mosp']);

  queue.markNotReady();
  assert.equal(queue.isReady(), false);
  assert.equal(queue.enqueue('fourth.mosp'), false);
  assert.equal(queue.markReady(), true);
  assert.deepEqual(sent, ['second.mosp', 'third.mosp', 'fourth.mosp']);
});

test('createProjectMessageQueue rejects a missing sender', () => {
  assert.throws(() => createProjectMessageQueue(null), /send must be a function/u);
});
