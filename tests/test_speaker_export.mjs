import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';

const context = { window: {} };
loadEditorModule(context, 'shared/editor-utils.js');
const helpers = context.window.AsrEditorUtils;

test('TXT and XML exports honour speaker names without mutating source text or timing', () => {
  const segments = [
    { start: 0, end: 1000, text: 'Alpha', color: { name: 'yellow' } },
    { start: 1000, end: 2000, text: 'Beta', color_ref: { headIdx: 0 } },
    { start: 2000, end: 3000, text: 'Hidden', disabled: true, color: { name: 'yellow' } },
    { start: 3000, end: 4000, text: 'Unnamed', color: { name: 'blue' } },
  ];
  const project = {
    media: '/synthetic.wav', waveform: { duration_ms: 4000 }, segments,
    gap_remove: { gaps: [{ start: 2100, end: 2500, removed: true }] },
    overlay_track: { enabled: true, segments: [{ start: 0, end: 1000, text: 'Overlay', color: { name: 'green' } }] },
    multi_subtitle: { enabled: true, tracks: [
      { segments: [{ start: 0, end: 1000, text: 'First', color: { name: 'yellow' } }] },
      { segments: [
        { start: 0, end: 1000, text: 'Second', color: { name: 'green' } },
        { start: 1000, end: 2000, text: 'Reference', color_ref: { headIdx: 0 } },
      ] },
    ] },
  };
  const before = JSON.stringify(project);
  const options = { speakerLabelsEnabled: true, speakerLabels: { yellow: 'Host', green: 'Guest', blue: '' }, speakerLabelSeparator: '"' };
  assert.equal(helpers.buildPlainTextPayload(segments, options), 'Host"Alpha\nHost"Beta\nUnnamed');
  assert.equal(helpers.buildPlainTextPayload(segments, { ...options, speakerLabelsEnabled: false }), 'Alpha\nBeta\nUnnamed');
  for (const timelineMode of ['source', 'gap_removed']) {
    const plain = helpers.buildProjectExportPlan(project, { timelineMode });
    const labelled = helpers.buildProjectExportPlan(project, { ...options, timelineMode });
    assert.deepEqual(Array.from(labelled.cues.main, (cue) => cue.text), ['Host"Alpha', 'Host"Beta', 'Unnamed']);
    assert.deepEqual(Array.from(labelled.cues.extension, (cue) => cue.text), ['Host"First', 'Guest"Second', 'Guest"Reference']);
    assert.equal(labelled.cues.overlay[0].text, 'Guest"Overlay');
    assert.deepEqual(Array.from(labelled.cues.main, (cue) => [cue.startMs, cue.endMs]), Array.from(plain.cues.main, (cue) => [cue.startMs, cue.endMs]));
    const [artifact] = helpers.buildFcp7ExportArtifacts(labelled, { subtitleTracks: 'all', nativeTextObjects: true });
    assert.match(artifact.content, /Host(?:&quot;|")Alpha/);
    assert.match(artifact.content, /Guest(?:&quot;|")Reference/);
  }
  assert.equal(JSON.stringify(project), before);
});
