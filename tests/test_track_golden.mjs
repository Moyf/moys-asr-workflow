import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { browserOutputs, fixtureNames, fixtureRoot, readFixture } from './helpers/track-golden.mjs';
for (const name of fixtureNames) {
  test(`v1 input to v2 browser save and preserved ASS/SRT baseline: ${name}`, () => {
    const input = readFixture(name);
    const before = structuredClone(input);
    const expected = JSON.parse(fs.readFileSync(new URL(`${name}.browser.json`, fixtureRoot), 'utf8'));
    const expectedV2 = JSON.parse(fs.readFileSync(new URL(`${name}.v2.browser.json`, fixtureRoot), 'utf8'));
    const actual = browserOutputs(input);
    // Keep the captured v1 serializer output as historical evidence. The
    // editor now writes v2 groups; its text exports retain the P0 baseline.
    assert.equal(expected.project.schema, 'moy.asr.project.v1');
    for (const key of ['ass', 'srt', 'secondarySrt', 'bilingualSrt', 'redSrt']) {
      assert.deepEqual(actual[key], expected[key], `${name}: ${key}`);
    }
    assert.equal(actual.project.schema, 'moy.asr.project.v2');
    assert.ok(Array.isArray(actual.project.subtitle_groups.color));
    assert.ok(Array.isArray(actual.project.subtitle_groups.sticker));
    assert.deepEqual(actual.project, expectedV2, `${name}: full v2 project`);
    assert.deepEqual(input, before);
    assert.deepEqual(browserOutputs(actual.project).project, actual.project, 'v2 save shape is stable on reopening');
  });
}
