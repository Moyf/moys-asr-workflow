import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { createUtilsModule } from '../web/shared/utils/gap-remove.js';
import { createCleanupProjectionCache } from '../web/shared/utils/cleanup-projection-cache.js';

vm.runInThisContext(fs.readFileSync(new URL('../web/shared/gap-remove-core.js', import.meta.url), 'utf8'));
const core = globalThis.AsrGapRemoveCore;
const utils = createUtilsModule({ gapRemoveCore: core });

function fixture(id = 'cue') {
  const cue = { id, start: 0, end: 1500, text: '甲乙丙', items: [
    { start: 0, end: 500, text: '甲' }, { start: 500, end: 1000, text: '乙' },
    { start: 1000, end: 1500, text: '丙' },
  ] };
  const gap = core.normalizeGapRemoveData({ provenance: { sources: { ai_cleanup: [
    { start: 500, end: 1000, cleanup_scope: { segment_id: id, item_start: 1, item_end: 2, text: '乙' } },
  ] } } });
  return { cue, gap };
}

function cacheRuntime() {
  const counts = { retainedBuilds: 0, retainedRuns: 0, exportBuilds: 0, exportRuns: 0 };
  const cache = createCleanupProjectionCache({
    createRetainedProjector(gap) {
      counts.retainedBuilds += 1;
      const project = core.createCleanupRetainedProjector(gap);
      return (cues) => { counts.retainedRuns += 1; return project(cues); };
    },
    createExportProjector(gap) {
      counts.exportBuilds += 1;
      const project = utils.createAiCleanupProjector(gap);
      return (cues) => { counts.exportRuns += 1; return project(cues); };
    },
  });
  return { cache, counts };
}

function assertEquivalent(cache, cues, gap) {
  assert.deepEqual(cache.exportSegments(cues, gap), utils.buildAiCleanupSegments(cues, gap));
  for (const cue of cues) assert.deepEqual(cache.retainedCue(cue, gap), core.projectCleanupRetainedSegments([cue], gap)[0]);
}

test('cue metadata changes and history replacement never return stale projected values', () => {
  const { cue, gap } = fixture();
  const { cache } = cacheRuntime();
  for (const enabled of [true, false, true]) {
    cache.setEnabled(enabled);
    for (const value of ['a', 'b', null]) {
      cue.speaker = value;
      assert.equal(cache.retainedCue(cue, gap).speaker, value);
      assert.equal(cache.exportSegments([cue], gap)[0].speaker, value);
      assert.equal(cache.retainedCue(cue, gap).text, '甲丙');
    }
  }
  cue.speaker = 'b';
  cache.retainedCue(cue, gap); cache.exportSegments([cue], gap);
  const restored = structuredClone(cue);
  cue.speaker = 'a';
  assert.equal(cache.retainedCue(cue, gap).speaker, 'a');
  assert.equal(cache.exportSegments([cue], gap)[0].speaker, 'a');
  assert.equal(cache.retainedCue(restored, gap).speaker, 'b');
  assert.equal(cache.exportSegments([restored], gap)[0].speaker, 'b');
  assertEquivalent(cache, [restored, cue], gap);
});

test('diagnostic switch defaults on, bypasses only caching and clears both projection lifetimes', () => {
  const { cue, gap } = fixture();
  const { cache, counts } = cacheRuntime();
  assert.equal(cache.isEnabled(), true);
  const before = cache.retainedCue(cue, gap);
  const exported = cache.exportSegments([cue], gap);
  assert.equal(before.text, '甲丙');
  const builds = { ...counts };
  cache.setEnabled(false);
  cache.setEnabled(true);
  assert.deepEqual(cache.retainedCue(cue, gap), before);
  assert.deepEqual(cache.exportSegments([cue], gap), exported);
  assert.equal(counts.retainedBuilds, builds.retainedBuilds + 1);
  assert.equal(counts.exportBuilds, builds.exportBuilds + 1);
  for (const enabled of [false, true, false, true]) {
    cache.setEnabled(enabled);
    assert.equal(cache.isEnabled(), enabled);
    assertEquivalent(cache, [cue], gap);
    assert.equal(cache.retainedCue(cue, gap).text, '甲丙');
  }
  cache.setEnabled(false);
  cue.items[1].text = '丁'; cue.text = '甲丁丙';
  assertEquivalent(cache, [cue], gap);
  cache.setEnabled(true);
  assertEquivalent(cache, [cue], gap);
});

test('unchanged playback frames reuse both projections and rebuild a changed cue only', () => {
  const { cue, gap } = fixture();
  const second = structuredClone(cue);
  second.id = 'other';
  const cues = [cue, second];
  const { cache, counts } = cacheRuntime();
  const retained = cache.retainedCue(cue, gap);
  const exported = cache.exportSegments(cues, gap);
  assert.equal(retained.text, '甲丙');
  const baseline = { ...counts };
  for (let frame = 0; frame < 30; frame += 1) {
    assert.equal(cache.retainedCue(cue, gap), retained);
    assert.equal(cache.exportSegments(cues, gap), exported);
  }
  assert.deepEqual(counts, baseline, 'warm frames must not invoke a projector again');
  second.text = '丁乙丙';
  second.items[0].text = '丁';
  const changed = cache.exportSegments(cues, gap);
  assert.equal(changed[0], exported[0], 'unmodified cue remains reusable');
  assert.equal(changed[1].text, '丁乙丙');
  assert.equal(counts.exportRuns, baseline.exportRuns + 1);
  assertEquivalent(cache, cues, gap);
});

test('in-place scope, effective gaps, provenance restoration and source replacement invalidate', () => {
  for (const mutate of [
    (cue, gap) => { gap.provenance.sources.ai_cleanup[0].cleanup_scope.text = '错'; },
    (cue, gap) => { gap.provenance.sources.ai_cleanup[0].cleanup_scope.item_end = 3; },
    (cue, gap) => { gap.provenance.sources.ai_cleanup[0].start = 501; },
    (cue, gap) => { gap.provenance.manual_overrides.push({ start: 500, end: 1000, removed: false }); },
    (cue, gap) => { gap.provenance.sources.ai_cleanup_review.push({ start: 0, end: 500, review_marker_id: 'review' }); },
    (cue, gap) => { gap.provenance.sources.script_alignment.push({ start: 0, end: 500 }); },
    (cue, gap) => { gap.provenance.sources.audio_gate.push({ start: 500, end: 1000 }); },
    (cue, gap) => { gap.gaps[0].removed = false; },
    (cue, gap) => { gap.provenance.sources.ai_cleanup = []; },
  ]) {
    const { cue, gap } = fixture();
    const { cache } = cacheRuntime();
    assertEquivalent(cache, [cue], gap);
    mutate(cue, gap);
    assertEquivalent(cache, [cue], gap);
    const replacement = fixture();
    assertEquivalent(cache, [replacement.cue], replacement.gap);
    assertEquivalent(cache, [cue], gap);
  }
});

test('in-place text, item values, cue metadata, disable and structure changes stay current', () => {
  for (const mutate of [
    (cue) => { cue.text = '甲丁丙'; cue.items[1].text = '丁'; },
    (cue) => { cue.items[1].start = 501; },
    (cue) => { cue.items[1].end = 999; },
    (cue) => { cue.items = cue.items.map((item) => ({ ...item })); cue.items[1].text = '丁'; },
    (cue) => { cue.disabled = true; },
    (cue) => { cue.start = 1; },
    (cue) => { cue.id = 'changed'; },
    (cue) => { cue.assOverride = { fontSize: 36 }; cue.speaker = 'speaker'; cue.extra = 1; },
    (cue) => { cue.items[2].confidence = 0.8; },
  ]) {
    const { cue, gap } = fixture();
    const { cache } = cacheRuntime();
    const cues = [cue];
    assertEquivalent(cache, cues, gap);
    mutate(cue);
    assertEquivalent(cache, cues, gap);
    const other = fixture('second').cue;
    cues.push(other);
    assertEquivalent(cache, cues, gap);
    cues.reverse();
    assertEquivalent(cache, cues, gap);
    cues.splice(0, 1);
    assertEquivalent(cache, cues, gap);
  }
});

test('ordinary retained scope and ASS/export punctuation and empty-cue semantics remain distinct', () => {
  const { cue, gap } = fixture();
  const { cache } = cacheRuntime();
  cue.text = '甲，乙丙';
  assert.equal(cache.retainedCue(cue, gap), cue, 'ordinary scope requires complete exact item text');
  assert.equal(cache.exportSegments([cue], gap)[0].text, '甲，丙', 'export retains unmatched punctuation');
  cue.text = '甲乙丙';
  const scope = gap.provenance.sources.ai_cleanup[0];
  Object.assign(scope, { start: 0, end: 1500 });
  Object.assign(scope.cleanup_scope, { item_start: 0, item_end: 3, text: cue.text });
  gap.gaps = [{ start: 0, end: 1500, removed: true }];
  assertEquivalent(cache, [cue], gap);
  assert.equal(cache.retainedCue(cue, gap).disabled, true);
  assert.equal(cache.exportSegments([cue], gap)[0].disabled, undefined);
});

test('no AI cleanup is an allocation-free projection fast path and releases the previous project', () => {
  const { cue, gap } = fixture();
  const { cache, counts } = cacheRuntime();
  cache.retainedCue(cue, gap);
  const plain = { provenance: { sources: { ai_cleanup: [] } },
    get gaps() { throw new Error('ordinary gap data must not be scanned without AI scopes'); } };
  const source = [cue];
  const baseline = { ...counts };
  for (let frame = 0; frame < 30; frame += 1) {
    assert.equal(cache.retainedCue(cue, plain), cue);
    assert.equal(cache.exportSegments(source, plain), source);
  }
  assert.deepEqual(counts, baseline);
  cache.retainedCue(cue, gap);
  assert.equal(counts.retainedBuilds, baseline.retainedBuilds + 1, 'old project context is not retained globally');
});

test('a cue without a local scope skips gap snapshots and observes newly added scopes', () => {
  const { cue, gap } = fixture();
  const local = structuredClone(gap.provenance.sources.ai_cleanup[0]);
  gap.provenance.sources.ai_cleanup[0].cleanup_scope.segment_id = 'elsewhere';
  const gaps = gap.gaps;
  let reads = 0;
  Object.defineProperty(gap, 'gaps', { configurable: true, get() { reads += 1; return gaps; } });
  const { cache, counts } = cacheRuntime();
  for (let frame = 0; frame < 30; frame += 1) assert.equal(cache.retainedCue(cue, gap), cue);
  assert.equal(reads, 0, 'unrelated cues must not inspect the full gaps input');
  assert.equal(counts.retainedBuilds, 0);
  gap.provenance.sources.ai_cleanup.push(local);
  assert.equal(cache.retainedCue(cue, gap).text, '甲丙', 'an in-place scope addition must be seen immediately');
  assert.ok(reads > 0);
  assert.equal(counts.retainedBuilds, 1);
});

test('scope moves, removal, restoration and cue ID edits leave and re-enter the local fast path', () => {
  const { cue, gap } = fixture();
  const { cache } = cacheRuntime();
  const range = gap.provenance.sources.ai_cleanup[0];
  assert.equal(cache.retainedCue(cue, gap).text, '甲丙');
  range.cleanup_scope.segment_id = 'elsewhere';
  assert.equal(cache.retainedCue(cue, gap), cue);
  // A manual restoration made while this cue is unrelated must still be checked
  // once its scope returns, including when the source root was never replaced.
  gap.provenance.manual_overrides.push({ start: 500, end: 1000, removed: false });
  range.cleanup_scope.segment_id = cue.id;
  assert.equal(cache.retainedCue(cue, gap), cue);
  gap.provenance.manual_overrides.length = 0;
  assert.equal(cache.retainedCue(cue, gap).text, '甲丙');
  gap.provenance.sources.ai_cleanup = [];
  assert.equal(cache.retainedCue(cue, gap), cue);
  gap.provenance.sources.ai_cleanup = [range];
  assert.equal(cache.retainedCue(cue, gap).text, '甲丙');
  cue.id = 'elsewhere';
  assert.equal(cache.retainedCue(cue, gap), cue);
  cue.id = 'cue';
  assert.equal(cache.retainedCue(cue, gap).text, '甲丙');
  const restoredProject = structuredClone(gap);
  assertEquivalent(cache, [structuredClone(cue)], restoredProject);
  assertEquivalent(cache, [cue], gap);
});

test('an unrelated cue in a new project releases the old context and leaves export invalidation intact', () => {
  const { cue, gap } = fixture();
  const other = fixture('other');
  const { cache, counts } = cacheRuntime();
  const retained = cache.retainedCue(cue, gap);
  const exported = cache.exportSegments([cue], gap);
  const before = { ...counts };
  assert.equal(cache.retainedCue(cue, other.gap), cue);
  assert.deepEqual(counts, before, 'switching to an unrelated project needs no projector');
  assert.equal(cache.retainedCue(cue, gap).text, retained.text);
  assert.equal(counts.retainedBuilds, before.retainedBuilds + 1, 'the old context must have been released');
  const source = [cue];
  cache.exportSegments(source, gap);
  gap.provenance.manual_overrides.push({ start: 500, end: 1000, removed: false });
  gap.gaps[0].removed = false;
  assert.equal(cache.retainedCue(other.cue, gap), other.cue);
  const changed = cache.exportSegments(source, gap);
  assert.notDeepEqual(changed, exported);
  assertEquivalent(cache, source, gap);
});

test('duplicate cue IDs, repeated words and missing fields do not merge cache entries or authorize stale scopes', () => {
  const { cue, gap } = fixture();
  const sameId = structuredClone(cue);
  sameId.text = '甲丁丙';
  sameId.items[1].text = '丁';
  const missing = { text: '', items: [] };
  const { cache } = cacheRuntime();
  const cues = [cue, sameId, missing, null];
  assertEquivalent(cache, cues, gap);
  assert.equal(cache.exportSegments(cues, gap)[1], sameId);
  Object.assign(cue, { text: '甲甲丙' });
  cue.items[1].text = '甲';
  gap.provenance.sources.ai_cleanup[0].cleanup_scope.text = '甲';
  assertEquivalent(cache, cues, gap);
  assert.equal(cache.retainedCue(cue, gap).text, '甲丙');
  gap.provenance.sources.ai_cleanup[0].cleanup_scope.item_start = 0;
  assertEquivalent(cache, cues, gap);
  assert.equal(cache.retainedCue(cue, gap), cue);
});
