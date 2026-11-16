// console-mirror 单元测试 + 编辑器 / Launcher 接线守卫。
// 报错类提示（toast / 错误面板）必须同步镜像到 DevTools 控制台；
// 接线一旦被移除，下面的源码级断言直接红灯。
import { createUtilsModule } from '../web/shared/utils/console-mirror.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function recordingConsole() {
  const calls = [];
  const target = {};
  for (const level of ['error', 'warn', 'info', 'log']) {
    target[level] = (...args) => calls.push({ level, args });
  }
  return { calls, target };
}

test('feedback level mapping keeps success and default toasts out of the console', () => {
  const mirror = createUtilsModule();
  assert.equal(mirror.feedbackConsoleLevel('warning'), 'warn');
  assert.equal(mirror.feedbackConsoleLevel('invalid'), 'warn');
  assert.equal(mirror.feedbackConsoleLevel('info'), 'info');
  assert.equal(mirror.feedbackConsoleLevel('default'), null);
  assert.equal(mirror.feedbackConsoleLevel('success'), null);
  assert.equal(mirror.feedbackConsoleLevel(undefined), null);
});

test('mirror prefixes the message and forwards the original error object', () => {
  const { calls, target } = recordingConsole();
  const mirror = createUtilsModule({ prefix: '[MAWE][hint]', getConsole: () => target });
  const failure = new Error('boom');
  assert.equal(mirror.mirrorFeedback(`导入字幕失败：${failure.message}`, 'warning', { error: failure }), true);
  assert.equal(mirror.mirrorFeedback('媒体时长尚未加载', 'invalid'), true);
  assert.equal(mirror.mirrorFeedback('已保存', 'success'), false);
  assert.deepEqual(calls.map((entry) => entry.level), ['warn', 'warn']);
  assert.deepEqual(calls[0].args, ['[MAWE][hint] 导入字幕失败：boom', failure]);
  assert.deepEqual(calls[1].args, ['[MAWE][hint] 媒体时长尚未加载']);
});

test('detail objects ride along for structured diagnostics', () => {
  const { calls, target } = recordingConsole();
  const mirror = createUtilsModule({ prefix: '[MAW Launcher]', getConsole: () => target });
  const detail = { code: 'asr_auth_failed', detail: '401', diagnostics: '' };
  mirror.mirrorFeedback('转写失败', 'warning', { detail });
  assert.deepEqual(calls, [{ level: 'warn', args: ['[MAW Launcher] 转写失败', detail] }]);
});

test('repeated identical messages are suppressed inside the rolling window', () => {
  const { calls, target } = recordingConsole();
  let clock = 0;
  const mirror = createUtilsModule({ getConsole: () => target, dedupeWindowMs: 1000, now: () => clock });
  assert.equal(mirror.mirrorFeedback('字幕时长不能小于 100ms', 'warning'), true);
  clock += 200;
  assert.equal(mirror.mirrorFeedback('字幕时长不能小于 100ms', 'warning'), false);
  clock += 200; // 仍在滚动窗口内：持续触发保持抑制
  assert.equal(mirror.mirrorFeedback('字幕时长不能小于 100ms', 'warning'), false);
  clock += 1100; // 距上次记录超过窗口：重新输出
  assert.equal(mirror.mirrorFeedback('字幕时长不能小于 100ms', 'warning'), true);
  assert.equal(mirror.mirrorFeedback('相邻字幕之间不足 100ms', 'warning'), true);
  assert.equal(calls.length, 3);
});

test('empty messages are never mirrored', () => {
  const { calls, target } = recordingConsole();
  const mirror = createUtilsModule({ getConsole: () => target });
  assert.equal(mirror.mirrorFeedback('', 'warning'), false);
  assert.equal(mirror.mirrorFeedback(null, 'warning'), false);
  assert.equal(mirror.mirrorFeedback('   ', 'warning'), false);
  assert.deepEqual(calls, []);
});

test('editor flashHint mirrors error-class toasts through the shared module', () => {
  const source = fs.readFileSync(new URL('../web/editor/ui/editor-hint.js', import.meta.url), 'utf8');
  assert.match(source, /from '\.\.\/\.\.\/shared\/utils\/console-mirror\.js'/);
  // 行首缩进后紧跟调用：被注释掉的接线不允许蒙混过关。
  assert.match(source, /\n\s*consoleMirror\.mirrorFeedback\(String\(msg \|\| card\.textContent \|\| ''\), type, options\)/);
});

test('launcher wires the shared mirror ahead of its classic consumer', () => {
  const webRoot = new URL('../web/', import.meta.url);
  const manifest = fs.readFileSync(new URL('launcher-scripts.txt', webRoot), 'utf8')
    .split('\n').map((line) => line.split('#')[0].trim()).filter(Boolean);
  const mirrorAt = manifest.indexOf('shared/utils/console-mirror.js');
  const errorsAt = manifest.indexOf('launcher/errors/launcher-errors.js');
  assert.ok(mirrorAt >= 0, 'console-mirror.js 必须进入 launcher 清单');
  assert.ok(errorsAt > mirrorAt, 'console-mirror.js 必须排在 launcher-errors.js 之前');

  const config = JSON.parse(fs.readFileSync(new URL('launcher-modules.json', webRoot), 'utf8'));
  const entry = config.modules.find((item) => item.file === 'shared/utils/console-mirror.js');
  assert.equal(entry?.kind, 'transition');
  assert.equal(entry?.exportName, 'createUtilsModule');
  assert.equal(entry?.binding, 'createConsoleMirror');

  const errors = fs.readFileSync(new URL('launcher/errors/launcher-errors.js', webRoot), 'utf8');
  assert.match(errors, /\n\s*mawConsoleMirror\.mirrorFeedback\(redactSensitive\(message\), "warning"/);
});
