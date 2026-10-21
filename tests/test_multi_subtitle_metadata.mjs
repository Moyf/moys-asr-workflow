import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';

const context = { window: {} };
loadEditorModule(context, 'shared/editor-utils.js');
const utils = context.window.AsrEditorUtils;

test('track swaps retain speaker and disabled metadata and keep discarded cues out of SRT', () => {
  const makeSegments = (prefix) => [
    { id: `${prefix}-discarded`, start: 0, end: 1000, text: `${prefix} discarded`, speaker: `${prefix}-speaker`, disabled: true },
    { id: `${prefix}-enabled`, start: 1200, end: 2200, text: `${prefix} enabled`, speaker: `${prefix}-other`, disabled: false },
    { id: `${prefix}-legacy`, start: 2400, end: 3400, text: `${prefix} legacy` },
  ];
  const project = utils.importProject({
    segments: makeSegments('main'),
    multi_subtitle: { enabled: true, tracks: [{ id: 'translation', segments: makeSegments('ext') }] },
  }).project;
  const originalMetadata = new Map([...utils.iterSegments(project)]
    .map(({ id, speaker, disabled }) => [id, { speaker, disabled }]));
  for (let round = 0; round < 2; round++) {
    assert.equal(utils.swapMainAndExtensionSubtitle(project).swapped, true);
    for (const { segments } of project.tracks) {
      for (const { id, speaker, disabled } of segments) {
        assert.deepEqual({ speaker, disabled }, originalMetadata.get(id));
      }
      assert.doesNotMatch(utils.buildSrtPayload(segments), /discarded/);
      assert.match(utils.buildSrtPayload(segments), /enabled/);
    }
  }
});
