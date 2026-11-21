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

test('v2 libraries predating karaoke import with disabled defaults and preserve explicit settings', () => {
  const historical = utils.defaultAssStyleLibrary();
  delete historical.assProfiles[0].animations.karaoke;
  const migrated = transfer.validate(historical);
  assert.equal(migrated.library.assProfiles[0].animations.karaoke.enabled, false);
  assert.ok(migrated.warnings.some(warning => warning.includes('animations.karaoke')));

  for (const enabled of [false, true]) {
    const current = utils.defaultAssStyleLibrary();
    current.assProfiles[0].animations.karaoke.enabled = enabled;
    const result = transfer.validate(current);
    assert.equal(result.library.assProfiles[0].animations.karaoke.enabled, enabled);
    assert.ok(!result.warnings.some(warning => warning.includes('animations.karaoke')));
  }
  const incomplete = utils.defaultAssStyleLibrary();
  incomplete.assProfiles[0].animations.karaoke = {};
  assert.throws(() => transfer.validate(incomplete), /karaoke\.enabled 缺失/u);
  incomplete.assProfiles[0].animations.karaoke = { enabled: 'invalid' };
  assert.throws(() => transfer.validate(incomplete), /karaoke\.enabled 的值无效/u);
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

for (const [caseName, suffix] of [['space', ' extra'], ['emoji', '🚀extra']]) {
  test(`long shared names survive repeated imports (${caseName} at truncation boundary)`, () => {
    const current = utils.defaultAssStyleLibrary();
    const name = `${'A'.repeat(67)}${suffix}`;
    current.styles[1].name = name;
    current.assProfiles[0].name = name;
    const incoming = structuredClone(current);
    incoming.styles[1].fontSize = 123;
    const { library } = transfer.merge(current, incoming);
    assert.equal(library.styles.at(-1).name.isWellFormed(), true);
    assert.equal(library.assProfiles.at(-1).name.isWellFormed(), true);
    const saved = utils.normalizeAssStyleLibrary(library);
    assert.deepEqual(transfer.merge(saved, incoming).added, []);
  });
}
