import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('editor manifest combines v2 speaker factories with main cue-domain ESM factories', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../web/editor-modules.json', import.meta.url), 'utf8'));
  const scriptNames = fs.readFileSync(new URL('../web/editor-scripts.txt', import.meta.url), 'utf8').split(/\r?\n/);
  const expected = new Map([
    ['editor/cues/editor-inline-edit.js', 'initMaweInlineEdit'],
    ['editor/cues/editor-split-core.js', 'initMaweSplitCore'],
    ['editor/cues/editor-split-context.js', 'initMaweSplitContext'],
    ['editor/cues/editor-segment-ops.js', 'initMaweSegmentOps'],
    ['editor/cues/editor-nav-preview.js', 'initMaweNavPreview'],
    ['editor/cues/editor-cue-events.js', 'initMaweCueEvents'],
    ['editor/cues/editor-cue-list-anchor.js', 'initMaweCueListAnchor'],
    ['editor/cues/editor-timeline.js', 'initMaweTimeline'],
    ['editor/styles/editor-speaker-labels.js', 'initMaweSpeakerLabels'],
    ['editor/styles/editor-speaker-manager.js', 'initMaweSpeakerManager'],
    ['editor/styles/editor-wiring-ass-cue-position.js', 'initWiringAssCuePositionModule'],
  ]);
  for (const [file, exportName] of expected) {
    const matches = manifest.modules.filter(item => item.file === file);
    assert.equal(matches.length, 1, `expected exactly one manifest entry for ${file}`);
    assert.equal(matches[0].kind, 'init');
    assert.equal(matches[0].exportName, exportName);
    assert.ok(scriptNames.includes(file), `${file} is missing from the execution-order list`);
  }
});
