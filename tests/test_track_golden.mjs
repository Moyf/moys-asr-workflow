import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { browserOutputs, fixtureNames, fixtureRoot, readFixture } from './helpers/track-golden.mjs';
for (const name of fixtureNames) {
  test(`v1 browser golden: ${name} JSON and ASS/SRT outputs`, () => {
    const input = readFixture(name);
    const before = structuredClone(input);
    const expected = JSON.parse(fs.readFileSync(new URL(`${name}.browser.json`, fixtureRoot), 'utf8'));
    const actual = browserOutputs(input);
    assert.deepEqual(actual, expected);
    assert.deepEqual(input, before);
    assert.deepEqual(browserOutputs(actual.project).project, expected.project, 'existing save shape is stable on reopening');
  });
}
