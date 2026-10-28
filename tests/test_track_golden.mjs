import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { browserOutputs, fixtureNames, fixtureRoot, readFixture } from './helpers/track-golden.mjs';
for (const name of fixtureNames) {
  test(`v1 input to v1.5 browser save and preserved ASS/SRT baseline: ${name}`, () => {
    const input = readFixture(name);
    const before = structuredClone(input);
    const expected = JSON.parse(fs.readFileSync(new URL(`${name}.browser.json`, fixtureRoot), 'utf8'));
    const expectedV15 = JSON.parse(fs.readFileSync(new URL(`${name}.v1.5.browser.json`, fixtureRoot), 'utf8'));
    const actual = browserOutputs(input);
    // Keep the captured v1 serializer output as historical evidence. The
    // editor now writes v1.5 groups; its text exports retain the P0 baseline.
    assert.equal(expected.project.schema, 'moy.asr.project.v1');
    for (const key of ['ass', 'srt', 'secondarySrt', 'bilingualSrt', 'redSrt']) {
      assert.deepEqual(actual[key], expected[key], `${name}: ${key}`);
    }
    assert.equal(actual.project.schema, 'moy.asr.project.v1.5');
    assert.ok(Array.isArray(actual.project.subtitle_groups.color));
    assert.ok(Array.isArray(actual.project.subtitle_groups.sticker));
    assert.deepEqual(actual.project, expectedV15, `${name}: full v1.5 project`);
    assert.deepEqual(input, before);
    assert.deepEqual(browserOutputs(actual.project).project, actual.project, 'v1.5 save shape is stable on reopening');
  });
}
