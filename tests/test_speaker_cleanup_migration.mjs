import test from 'node:test';
import assert from 'node:assert/strict';
import '../web/shared/gap-remove-core.js';
import { upgradeProjectSpeakers } from '../web/shared/utils/speaker-identity.js';
import { createUtilsModule } from '../web/shared/utils/project-tracks.js';
import { createUtilsModule as cleanupUtils } from '../web/shared/utils/gap-remove.js';

const core = globalThis.AsrGapRemoveCore;
const cleanup = cleanupUtils({ gapRemoveCore: core });
function project(first = 1, last = 2) {
  const items = ['A', ' B', '，C'].map((text, i) => ({ text, start: i * 600, end: i * 600 + 500, speaker: i ? 'b' : 'a' }));
  const cue = { id: 'cue', start: 0, end: 1700, text: 'A B，C', items, assStyle: { font: 'x' }, vendor: 3 };
  const range = { id: 'cut', start: items[first].start, end: items[last - 1].end, vendor: 7,
    cleanup_scope: { segment_id: 'cue', item_start: first, item_end: last,
      text: items.slice(first, last).map(item => item.text).join(''), vendor: 9 } };
  return { schema: 'moy.asr.project.v2', tracks: [{ id: 'main', role: 'main', name: 'Main', enabled: true, segments: [cue] }], bindings: [],
    bilingual: { display_mode: 'both' }, subtitle_groups: { next_id: 1, color: [], sticker: [] },
    processing_overrides: { text: [] }, styles: { vendor: true }, gap_remove: core.normalizeGapRemoveData({ provenance: { sources: { ai_cleanup: [range] } } }) };
}
test('speaker migration preserves exact cleanup, pauses, metadata and restoration', () => {
  for (const [first, last] of [[1, 2], [0, 2]]) {
    const before = project(first, last), after = createUtilsModule().importProject(before).project;
    const oldText = core.projectCleanupRetainedSegments(before.tracks[0].segments, before.gap_remove).map(c => c.text).join('');
    const text = core.projectCleanupRetainedSegments(after.tracks[0].segments, after.gap_remove).map(c => c.text).join('');
    assert.equal(text, oldText);
    assert.deepEqual(core.gapRangesFromProvenance(after.gap_remove.provenance), core.gapRangesFromProvenance(before.gap_remove.provenance));
    assert.deepEqual(after.processing_overrides, before.processing_overrides);
    assert.deepEqual(after.styles, before.styles);
    assert.ok(after.tracks[0].segments.every(c => c.assStyle.font === 'x' && c.vendor === 3));
    assert.ok(after.gap_remove.provenance.sources.ai_cleanup.filter(x => x.cleanup_scope).every(x => x.cleanup_scope.vendor === 9));
    after.gap_remove.provenance.manual_overrides.push({ start: before.gap_remove.provenance.sources.ai_cleanup[0].start,
      end: before.gap_remove.provenance.sources.ai_cleanup[0].end, removed: false });
    assert.equal(core.projectCleanupRetainedSegments(after.tracks[0].segments, after.gap_remove).map(c => c.text).join(''), 'A B，C');
  }
});
test('stale scope cannot become valid after a split', () => {
  const before = project(); before.gap_remove.provenance.sources.ai_cleanup[0].cleanup_scope.text = 'stale';
  const after = upgradeProjectSpeakers(before);
  assert.equal(after.gap_remove.provenance.sources.ai_cleanup[0].cleanup_scope, undefined);
  assert.equal(core.projectCleanupRetainedSegments(after.tracks[0].segments, after.gap_remove).map(c => c.text).join(''), 'A B，C');
});
test('export-authorized punctuation and whitespace survive migration', () => {
  for (const [text, values] of [['A，BC', ['A', 'B', 'C']], ['A B C', ['A', 'B', 'C']],
    [' A B，C ', ['A', ' B', '，C']], ['A B C', [' A', ' B', ' C']], ['A B C', ['A', ' B', ' C ']]]) {
    const before = project(); const cue = before.tracks[0].segments[0];
    cue.text = text; cue.items.forEach((item, i) => { item.text = values[i]; });
    before.gap_remove.provenance.sources.ai_cleanup[0].cleanup_scope.text = values[1];
    const oldExport = cleanup.buildAiCleanupSegments([cue], before.gap_remove).map(c => c.text).join('');
    const after = createUtilsModule().importProject(before).project;
    assert.equal(after.tracks[0].segments.map(c => c.text).join(''), text);
    const exported = cleanup.buildAiCleanupSegments(after.tracks[0].segments, after.gap_remove).map(c => c.text).join('');
    assert.ok(!oldExport.includes('B') && !exported.includes('B'), `${text}: ${oldExport} => ${exported}`);
    if (text.startsWith(' ')) assert.ok(!core.projectCleanupRetainedSegments(after.tracks[0].segments, after.gap_remove).map(c => c.text).join('').includes('B'));
  }
});
test('dangling scope cannot acquire a generated cue id', () => {
  const before = project();
  before.gap_remove.provenance.sources.ai_cleanup[0].cleanup_scope.segment_id = 'cue-speaker-1';
  const after = createUtilsModule().importProject(before).project;
  assert.notEqual(after.tracks[0].segments[1].id, 'cue-speaker-1');
  assert.equal(cleanup.buildAiCleanupSegments(after.tracks[0].segments, after.gap_remove).map(c => c.text).join(''), 'A B，C');
});

test('swap, save and identity upgrade preserve a secondary cleanup scope without affecting main', async () => {
  const { loadEditorModule } = await import('./helpers/editor-module-loader.mjs');
  const context = {}; context.window = context; loadEditorModule(context, 'shared/editor-utils.js');
  const utils = context.AsrEditorUtils;
  for (const stale of [false, true]) {
    const before = project();
    before.tracks.push({ id: 'translation', role: 'secondary', name: 'Translation', enabled: true,
      segments: [{ id: 'translation-cue', start: 0, end: 1700, text: 'translation', items: [] }] });
    before.bilingual.active_track_id = 'translation';
    if (stale) before.gap_remove.provenance.sources.ai_cleanup[0].cleanup_scope.text = 'stale';
    assert.equal(utils.swapMainAndExtensionSubtitle(before).swapped, true);
    const saved = JSON.parse(JSON.stringify(before));
    const original = utils.getExtensionTrack(saved).segments;
    const expected = cleanup.buildAiCleanupSegments(original, saved.gap_remove).map(c => c.text).join('');
    const beforeAudio = core.gapRangesFromProvenance(saved.gap_remove.provenance);
    const after = utils.importProject(saved).project;
    const secondary = utils.getExtensionTrack(after).segments;
    const actual = cleanup.buildAiCleanupSegments(secondary, after.gap_remove).map(c => c.text).join('');
    assert.equal(actual, expected);
    assert.equal(stale ? actual.includes('B') : !actual.includes('B'), true);
    assert.equal(utils.getMainTrack(after).segments[0].text, 'translation');
    assert.deepEqual(core.gapRangesFromProvenance(after.gap_remove.provenance), beforeAudio);
    assert.equal(core.projectCleanupRetainedSegments(secondary, after.gap_remove).map(c => c.text).join(''), expected);
    if (stale) assert.equal(after.gap_remove.provenance.sources.ai_cleanup[0].cleanup_scope, undefined);
  }
});

test('migration remaps independent scopes on both tracks and leaves unrelated scopes intact', () => {
  const before = project();
  const main = before.tracks[0].segments[0];
  const secondary = JSON.parse(JSON.stringify(main)); secondary.id = 'secondary-cue';
  before.tracks.push({ id: 'secondary', role: 'secondary', name: 'Secondary', enabled: true, segments: [secondary] });
  before.bilingual.active_track_id = 'secondary';
  const scope = before.gap_remove.provenance.sources.ai_cleanup[0];
  before.gap_remove.provenance.sources.ai_cleanup.push({ ...structuredClone(scope), id: 'second',
    cleanup_scope: { ...scope.cleanup_scope, segment_id: secondary.id } });
  before.gap_remove.provenance.sources.ai_cleanup.push({ id: 'unrelated', start: 2000, end: 2200,
    cleanup_scope: { segment_id: 'missing', item_start: 0, item_end: 1, text: 'x' } });
  const after = createUtilsModule().importProject(before).project;
  for (const track of after.tracks) assert.equal(cleanup.buildAiCleanupSegments(track.segments, after.gap_remove).map(c => c.text).join(''), 'A，C');
  assert.equal(after.gap_remove.provenance.sources.ai_cleanup.find(x => x.id === 'unrelated').cleanup_scope.segment_id, 'missing');
});

test('scope follows a cue through overlay migration and back to main', async () => {
  const { loadEditorModule } = await import('./helpers/editor-module-loader.mjs');
  const context = {}; context.window = context; loadEditorModule(context, 'shared/editor-utils.js');
  const utils = context.AsrEditorUtils, before = project();
  const main = utils.getMainTrack(before), overlay = utils.ensureOverlayTrack(before);
  overlay.enabled = true;
  assert.equal(utils.moveSegmentBetweenTracks(main.segments, overlay.segments, 0), 0);
  const after = utils.importProject(JSON.parse(JSON.stringify(before))).project;
  const restoredMain = utils.getMainTrack(after), restoredOverlay = utils.getOverlayTrack(after);
  while (restoredOverlay.segments.length) utils.moveSegmentBetweenTracks(restoredOverlay.segments, restoredMain.segments, 0);
  assert.equal(cleanup.buildAiCleanupSegments(restoredMain.segments, after.gap_remove).map(c => c.text).join(''), 'A，C');
});
