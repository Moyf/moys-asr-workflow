import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createUtilsModule } from '../web/shared/utils/ass-style.js';
import { createAssStyleTransfer } from '../web/editor/styles/editor-wiring-ass-transfer.js';

const utils = createUtilsModule({ getNavigator: () => ({ platform: 'Win32' }), cloneJsonValue: x => structuredClone(x) });
const transfer = createAssStyleTransfer(utils);

test('historical libraries migrate without discarding supplied settings', () => {
  for (const filename of ['legacy-v1.json', 'legacy-v2-before-pop.json', 'legacy-v2-before-comment.json', 'legacy-v2-before-opacity.json']) {
    const input = JSON.parse(readFileSync(new URL(`./fixtures/ass-styles/${filename}`, import.meta.url), 'utf8'));
    const result = transfer.validate(input);
    assert.ok(result.warnings.length, filename);
    assert.ok(result.library.styles.find(style => style.id === 'ass-extension'), filename);
    assert.ok(result.library.assProfiles[0].animations.pop, filename);
  }
});

test('missing dependencies and future versions are rejected', () => {
  const input = utils.defaultAssStyleLibrary();
  input.assProfiles[0].styleId = 'absent';
  assert.throws(() => transfer.validate(input), /引用的样式不存在/u);
  input.version = 99;
  assert.throws(() => transfer.validate(input), /受支持/u);
});

test('merge preserves local built-ins, rewrites references and is repeatable', () => {
  const current = utils.defaultAssStyleLibrary();
  const incoming = structuredClone(current);
  incoming.styles[1].fontSize = 123;
  const first = transfer.merge(current, incoming);
  assert.equal(first.library.styles.find(style => style.id === 'ass').fontSize, current.styles[1].fontSize);
  const imported = first.library.styles.find(style => style.fontSize === 123);
  assert.ok(imported);
  assert.ok(first.library.assProfiles.some(profile => profile.styleId === imported.id));
  assert.deepEqual(first.library.assignments, current.assignments);
  const second = transfer.merge(first.library, incoming);
  assert.deepEqual(second.library, first.library);
  assert.equal(second.added.length, 0);
});
