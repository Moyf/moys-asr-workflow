import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { browserOutputs, createProjectHarness, fixtureNames, fixtureRoot, readFixture } from './helpers/track-golden.mjs';

// Migrate the historical saved golden, then account for intentional changes
// in the v2 serializer and ID allocation when importing the original v1 input.
function expectedCanonical(name, input, golden) {
  const { h } = createProjectHarness(input);
  const before = structuredClone(golden);
  const legacy = structuredClone(golden);
  legacy.preview.subtitle = { ...legacy.preview.subtitle, ...h.normalizePreviewGeometry(legacy.preview.subtitle) };
  const legacyBeforeImport = structuredClone(legacy);
  const expected = JSON.parse(JSON.stringify(h.importProject(legacy).project));
  assert.deepEqual(legacy, legacyBeforeImport, 'import does not mutate the old project');
  assert.deepEqual(golden, before, 'preparing the canonical expectation does not alter the historical golden');
  expected.subtitle_groups.next_id = 1;
  expected.preview.sticker = h.normalizePreviewGeometry(golden.preview?.sticker, h.DEFAULT_STICKER_GEOMETRY);
  for (const key of ['media', 'sticker_root', 'subtitle_group_migration']) {
    if (!Object.hasOwn(input, key)) delete expected[key];
  }
  for (const track of expected.tracks) {
    const original = track.role === 'main' ? input : track.role === 'overlay' ? input.overlay_track
      : input.multi_subtitle?.tracks?.find(item => item.id === track.id);
    track.segments.forEach((segment, index) => {
      if (!Object.hasOwn(original?.segments?.[index] || {}, 'items')) delete segment.items;
    });
  }
  if (name === 'legacy') {
    const main = expected.tracks.find(track => track.role === 'main');
    main.segments[0].id = 'main-cue-1';
    delete main.language; delete main.model; delete main.split_mode_override;
  }
  if (name === 'three-tracks') {
    expected.tracks.find(track => track.id === 'translation').segments[0].id = 'translation-cue-1';
    expected.bindings[0].target.segment_id = 'translation-cue-1';
  }
  if (name === 'color-sticker-groups') {
    const sticker = expected.subtitle_groups.sticker.find(group => group.id === 'sticker-extension-1-1');
    sticker.id = 'sticker-translation-1';
    expected.tracks.find(track => track.id === 'translation').segments[0].sticker_group_id = sticker.id;
  }
  return JSON.parse(JSON.stringify(expected));
}
for (const name of fixtureNames) {
  test(`v1 input to v2 browser save and preserved ASS/SRT baseline: ${name}`, () => {
    const input = readFixture(name);
    const before = structuredClone(input);
    const expected = JSON.parse(fs.readFileSync(new URL(`${name}.browser.json`, fixtureRoot), 'utf8'));
    const expectedV15 = JSON.parse(fs.readFileSync(new URL(`${name}.v1.5.browser.json`, fixtureRoot), 'utf8'));
    const actual = browserOutputs(input);
    // Keep the captured v1 serializer output as historical evidence. The
    // editor now writes v2 tracks. Manual positioning intentionally changes
    // ASS layers and activates the secondary position/scale stored in v1.
    assert.equal(expected.project.schema, 'moy.asr.project.v1');
    for (const key of ['ass', 'srt', 'secondarySrt', 'bilingualSrt', 'redSrt']) {
      const baseline = name === 'manual-ass' && key === 'ass'
        ? fs.readFileSync(new URL('manual-ass.positioned.ass', fixtureRoot), 'utf8')
        : expected[key];
      assert.deepEqual(actual[key], baseline, `${name}: ${key}`);
    }
    assert.equal(expectedV15.schema, 'moy.asr.project.v1.5');
    assert.equal(actual.project.schema, 'moy.asr.project.v2');
    for (const key of ['segments', 'overlay_track', 'multi_subtitle']) assert.equal(Object.hasOwn(actual.project, key), false);
    assert.ok(Array.isArray(actual.project.subtitle_groups.color));
    assert.ok(Array.isArray(actual.project.subtitle_groups.sticker));
    assert.deepEqual(actual.project, expectedCanonical(name, input, expectedV15), `${name}: full v2 project`);
    assert.deepEqual(input, before);
    assert.deepEqual(browserOutputs(actual.project).project, actual.project, 'v2 save shape is stable on reopening');
  });
}
