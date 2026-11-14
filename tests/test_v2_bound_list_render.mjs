import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { createUtilsModule as createData } from '../web/shared/utils/data.js';
import { createUtilsModule as createMulti } from '../web/shared/utils/multi-subtitle.js';

const { stableId } = createData({});
const { bindingForSegment } = createMulti({ stableId });

function makeElement() {
  const classes = new Set();
  const element = {
    dataset: {}, children: [], style: { setProperty() {}, removeProperty() {} },
    classList: {
      add: (...items) => items.forEach(item => classes.add(item)),
      remove: (...items) => items.forEach(item => classes.delete(item)),
      contains: item => classes.has(item),
      toggle: (item, state) => { const on = state === undefined ? !classes.has(item) : state; if (on) classes.add(item); else classes.delete(item); },
    },
    append(...items) { this.children.push(...items); },
    appendChild(item) { this.children.push(item); return item; },
    querySelector(selector) {
      if (selector !== '.multi-cue-column.extension') return null;
      return this.children.find(child => child.classList?.contains('multi-cue-column') && child.classList.contains('extension')) || null;
    },
  };
  Object.defineProperty(element, 'className', { set(value) { classes.clear(); value.split(/\s+/).filter(Boolean).forEach(item => classes.add(item)); } });
  return element;
}

function fixture() {
  const main = { id: 'main', role: 'main', segments: [{ id: 'same', start: 0, end: 1000, text: 'main' }] };
  const track = { id: 'secondary', role: 'secondary', segments: [
    { id: 'same', start: 0, end: 1000, text: 'same ID' },
    { id: 'other', start: 1200, end: 2000, text: 'other' },
  ] };
  const project = { tracks: [main, track], bindings: [] };
  let lookups = 0;
  const context = {
    document: { addEventListener() {}, createElement: makeElement, createTextNode: text => ({ textContent: text }) },
    MaweBoot: { DATA: project }, MaweDom: { searchEl: { value: '' } },
    MaweTimeline: { timelineIsFrameMode: () => false },
    MaweCueListAnchor: { setCueListIdentity() {} }, MaweCueEvents: { bindCueEvents() {} },
    MaweInlineEdit: { bindExtensionCueEvents() {} },
    MaweMultiSubtitleCore: { bindingForExtensionIndex(index, currentTrack) {
      lookups += 1;
      return bindingForSegment(project, currentTrack.segments[index]?.id, 'extension', currentTrack.id);
    } },
  };
  context.window = { AsrEditorUtils: { stableId, getMainTrack: () => main, resolveProjectSpeaker: () => null } };
  vm.runInNewContext(fs.readFileSync(new URL('../web/editor/cues/editor-cue-elements.js', import.meta.url), 'utf8'), context);
  return { api: context.window.MaweCueElements, project, track, getLookups: () => lookups };
}

test('v2 list index matches target-side, active-track lookup and is rebuilt after changes', () => {
  const { api, project, track, getLookups } = fixture();
  project.bindings = [
    { source: { track_id: 'main', segment_id: 'same' }, target: { track_id: 'secondary', segment_id: 'other' } },
    { source: { track_id: 'main', segment_id: 'main-2' }, target: { track_id: 'other-track', segment_id: 'same' } },
  ];
  const index = api.buildBoundExtensionIds(project.bindings, track.id);
  for (const [i, segment] of track.segments.entries()) {
    const oldResult = Boolean(bindingForSegment(project, segment.id, 'extension', track.id));
    const indexed = api.buildMultiCueColumn(segment, i, track, 'extension', index);
    assert.equal(!indexed.classList.contains('unbound'), oldResult);
  }
  assert.equal(getLookups(), 0);
  assert.equal(api.buildMultiCueColumn(track.segments[0], 0, track, 'extension', index).classList.contains('unbound'), true);
  assert.equal(api.buildMultiCueColumn(track.segments[1], 1, track, 'extension', index).classList.contains('unbound'), false);

  const otherTrackIndex = api.buildBoundExtensionIds(project.bindings, 'other-track');
  assert.equal(api.buildMultiCueColumn(track.segments[0], 0, track, 'extension', otherTrackIndex).classList.contains('unbound'), false);
  project.bindings = [];
  const afterUnbind = api.buildBoundExtensionIds(project.bindings, track.id);
  assert.equal(api.buildMultiCueColumn(track.segments[1], 1, track, 'extension', afterUnbind).classList.contains('unbound'), true);
  project.bindings.push({ source: { segment_id: 'same' }, target: { track_id: track.id, segment_id: 'same' } });
  const afterRebind = api.buildBoundExtensionIds(project.bindings, track.id);
  assert.equal(api.buildMultiCueColumn(track.segments[0], 0, track, 'extension', afterRebind).classList.contains('unbound'), false);
});

test('v2 dual builder keeps callers without the optional render index compatible', () => {
  const { api, project, track, getLookups } = fixture();
  project.bindings.push({ source: { segment_id: 'same' }, target: { track_id: track.id, segment_id: 'same' } });
  const noIndex = api.buildDualCueEl(0, 0, track);
  assert.equal(noIndex.querySelector('.multi-cue-column.extension').classList.contains('unbound'), false);
  assert.equal(getLookups(), 1);
  const index = api.buildBoundExtensionIds(project.bindings, track.id);
  const indexed = api.buildDualCueEl(0, 0, track, index);
  assert.equal(indexed.querySelector('.multi-cue-column.extension').classList.contains('unbound'), false);
  assert.equal(getLookups(), 1);
});

test('v2 list index uses the same normalized cue ID and strict target ID semantics', () => {
  const { api, project, track } = fixture();
  track.segments = [
    { id: ' padded ', start: 0, end: 1000, text: 'x' },
    { id: '', start: 1200, end: 2000, text: 'y' },
    { id: 42, start: 2200, end: 3000, text: 'z' },
  ];
  project.bindings = [
    { target: { track_id: track.id, segment_id: 'padded' } },
    { target: { track_id: track.id, segment_id: '' } },
    { target: { track_id: track.id, segment_id: 42 } },
  ];
  const index = api.buildBoundExtensionIds(project.bindings, track.id);
  for (const [i, segment] of track.segments.entries()) {
    const expected = Boolean(bindingForSegment(project, segment.id, 'extension', track.id));
    assert.equal(!api.buildMultiCueColumn(segment, i, track, 'extension', index).classList.contains('unbound'), expected);
  }
});
