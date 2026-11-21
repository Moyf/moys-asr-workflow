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

for (const [variant, enabled] of [['default', false], ['karaoke', true]]) {
  test(`actual 1.x ${variant} export preserves the entire library`, () => {
    const file = new URL(`./fixtures/ass-styles/main-f345a896-${variant}.json`, import.meta.url);
    const input = JSON.parse(readFileSync(file, 'utf8'));
    const { library, warnings } = transfer.validate(input);
    const assigned = library.assProfiles.find(profile => profile.id === library.assignments.assExportProfileId);
    assert.equal(assigned.animations.karaoke.enabled, enabled);
    assert.deepEqual(library, input.library);
    assert.equal(warnings.some(warning => warning.includes('逐字换色设置')), enabled);
    assert.deepEqual(transfer.validate({ ...input, library }).library, library);
  });
}

test('a supported karaoke group does not allow unknown or invalid fields', () => {
  const input = utils.defaultAssStyleLibrary();
  input.assProfiles[0].animations.karaoke = { enabled: 'true' };
  assert.throws(() => transfer.validate(input), /karaoke\.enabled/u);
  input.assProfiles[0].animations.karaoke = { enabled: true, unknown: 'value' };
  assert.throws(() => transfer.validate(input), /karaoke\.unknown/u);
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
