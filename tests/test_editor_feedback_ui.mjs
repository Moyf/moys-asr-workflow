import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const read = path => fs.readFileSync(new URL(`../web/${path}`, import.meta.url), 'utf8');
const factory = (source, dependencies, globals = {}) => vm.runInNewContext(
  source.replace('export function createWaveformModule', 'function createWaveformModule') + '\ncreateWaveformModule', globals)(dependencies);

function checkSettings(source) {
  let stored = '{}';
  const api = factory(source, {
    storage: { getItem: () => stored, setItem: (_, value) => { stored = value; } },
    DEFAULT_SETTINGS: {}, ZOOM_PRESETS: [], ROW_PRESETS: [], ROW_HEIGHT_PRESETS: [],
    normalizeLayoutData: () => ({}), clampWaveformScale: x => x,
  });
  assert.equal(api.readSettings().showCueTooltip, false);
  assert.equal(api.readSettings().showExtensionColors, false);
  for (const enabled of [true, false]) {
    api.saveSettings({ showCueTooltip: enabled, showExtensionColors: enabled });
    assert.equal(api.readSettings().showCueTooltip, enabled);
    assert.equal(api.readSettings().showExtensionColors, enabled);
  }
}
test('display defaults and explicit preferences round trip; old default is rejected', () => {
  const source = read('editor/media/waveform/settings.js');
  checkSettings(source);
  assert.throws(() => checkSettings(source.replace('parsed.showCueTooltip === true', 'parsed.showCueTooltip !== false')), assert.AssertionError);
});

function checkBadge(source) {
  const body = source.match(/function refreshSpeakerBadge\(badge, speaker\) \{([\s\S]*?)\n  \}/)[1];
  const refresh = vm.runInNewContext(`(badge, speaker) => {${body}}`, {
    speakerName: s => s?.name || 'Unassigned', speakerDescription: s => s?.name || 'Unassigned',
  });
  const badge = { hidden: false, classList: { toggle() {} }, style: { setProperty() {}, removeProperty() {} } };
  refresh(badge, null);
  assert.equal(badge.hidden, true);
  refresh(badge, { name: 'Alice', color: '#ffffff' });
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, 'Alice');
  refresh(badge, null);
  assert.equal(badge.hidden, true);
}
test('speaker badges hide unassigned identities on every refresh; removed guard fails', () => {
  const source = read('editor/cues/editor-cue-elements.js');
  checkBadge(source);
  assert.throws(() => checkBadge(source.replace('badge.hidden = !speaker;', '')), assert.AssertionError);
  const checkHiddenCss = css => assert.match(css, /\.cue-speaker-badge\[hidden\] \{ display: none; \}/);
  const css = read('editor.css');
  checkHiddenCss(css);
  assert.throws(() => checkHiddenCss(css.replace('.cue-speaker-badge[hidden] { display: none; }', '')), assert.AssertionError);
});

function checkSwatches(source) {
  assert.doesNotMatch(source, /className = 'speaker-context-slot(?:-name)?'/);
  assert.match(source, /width:22px;height:22px;border-radius:50%/);
  assert.match(source, /\.title = speakerMode/);
}
test('both context menus retain only compact circles and title names; cards fail', () => {
  for (const path of ['editor/ui/editor-context-menus.js', 'editor/ui/editor-wiring-context-menus.js']) {
    const source = read(path);
    checkSwatches(source);
    assert.throws(() => checkSwatches(source + "\nlabel.className = 'speaker-context-slot-name';"), assert.AssertionError);
  }
  const css = read('editor.css');
  assert.match(css, /grid-template-columns: repeat\(10, 7px\)/);
  assert.match(css, /nth-child\(6\) \{ grid-column: 2 \/ span 2/);
});

function checkLaneGap(css) {
  assert.match(css, /--multi-subtitle-lane-gap: 3px/);
  assert.match(css, /lane-height\) \* 2 \+ var\(--multi-subtitle-lane-gap\) \+ 3px/);
  assert.match(css, /waveform-cue-tooltip-setting \{[^}]*margin: 0;/);
}
test('lane gap and overlay offset reserve outline space; zero gap fails', () => {
  const css = read('waveform.css');
  checkLaneGap(css);
  assert.throws(() => checkLaneGap(css.replace('--multi-subtitle-lane-gap: 3px', '--multi-subtitle-lane-gap: 0px')), assert.AssertionError);
});

function checkExtension(source) {
  const blocks = [];
  const element = () => ({ dataset: {}, style: { setProperty(k, v) { this[k] = v; } },
    classList: { values: [], add(v) { this.values.push(v); } }, appendChild() {}, addEventListener() {} });
  const segment = { start: 100, end: 900, text: 'translated', color_group_id: 'cross-track' };
  const methods = factory(source, {
    wordTimingFullLane: () => false, findActiveCueIndex: () => -1, firstCueIndexOverlapping: () => 0,
    colorForSegment: s => { assert.equal(s, segment); return '#abcdef'; }, hasSubtitleColor: () => true,
  }, { document: { createElement: element } });
  for (const enabled of [false, true]) {
    blocks.length = 0;
    const instance = {
      settings: { mode: 'multi', rowHeight: 120, showExtensionColors: enabled },
      options: { multiSubtitleVisible: () => true, getSegments: () => [], getSelection: () => new Set(), getExtensionSegments: () => [segment] },
      currentTimeMs: () => 0, computeGroupBadgesCached: () => new Map(), appendSharedBoundaryZones() {},
      setBindingMarker() {}, appendExtensionHandle() {}, layoutBlock() {},
    };
    methods.appendCueBlocks.value.call(instance, { appendChild: b => blocks.push(b) }, 0, 1000);
    assert.equal(blocks[0].style['--cue-color'], enabled ? '#abcdef' : '#7a9fc5');
    assert.equal(blocks[0].classList.values.includes('has-subtitle-color'), enabled);
    assert.equal(blocks[0].title, undefined);
  }
}
test('secondary blocks use shared display color only when enabled; fixed neutral fails', () => {
  const source = read('editor/media/waveform/cue-blocks.js');
  checkExtension(source);
  assert.throws(() => checkExtension(source.replace("this.settings.showExtensionColors === true ? colorForSegment(segment) : '#7a9fc5'", "'#7a9fc5'")), assert.AssertionError);
});

function overlayGeometry(source, { rowHeight, wordTiming = false, multiLane = true, clientHeight = 0, mode = 'multi', contentHeight = 0 }) {
  const blocks = [];
  const element = () => ({ dataset: {}, style: { setProperty() {} },
    classList: { values: [], add(v) { this.values.push(v); } }, appendChild() {}, addEventListener() {} });
  const methods = factory(source, {
    wordTimingFullLane: () => false, findActiveCueIndex: () => -1, firstCueIndexOverlapping: () => 0,
    colorForSegment: () => '#abcdef',
  }, { document: { createElement: element } });
  const instance = {
    settings: { mode, rowHeight, showGroupBadges: false }, content: { clientHeight: contentHeight },
    options: {
      multiSubtitleVisible: () => multiLane, wordTiming: { enabled: wordTiming },
      getSegments: track => track === 'overlay' ? [{ start: 100, end: 900, text: 'overlay' }] : [],
      getSelection: () => new Set(),
    },
    currentTimeMs: () => 0, computeGroupBadgesCached: () => new Map(),
    appendSharedBoundaryZones() {}, layoutBlock() {},
  };
  methods.appendCueBlocks.value.call(instance, { clientHeight, appendChild: b => blocks.push(b) }, 0, 1000);
  return blocks[0].classList.values.includes('overlay-cover-mode');
}

function checkOverlayThresholds(source) {
  for (const rowHeight of [64, 80, 96, 120, 126]) {
    assert.equal(overlayGeometry(source, { rowHeight }), true, `normal bilingual ${rowHeight}`);
  }
  assert.equal(overlayGeometry(source, { rowHeight: 127 }), false);
  assert.equal(overlayGeometry(source, { rowHeight: 127, clientHeight: 124 }), true, 'actual clientHeight overrides nominal height');
  assert.equal(overlayGeometry(source, { rowHeight: 127, clientHeight: 125 }), false);
  for (const rowHeight of [120, 140, 144]) {
    assert.equal(overlayGeometry(source, { rowHeight, wordTiming: true }), true, `word bilingual ${rowHeight}`);
  }
  assert.equal(overlayGeometry(source, { rowHeight: 145, wordTiming: true }), false);
  assert.equal(overlayGeometry(source, { rowHeight: 145, wordTiming: true, clientHeight: 142 }), true);
  assert.equal(overlayGeometry(source, { rowHeight: 145, wordTiming: true, clientHeight: 143 }), false);
  for (const multiLane of [false, true]) {
    for (const rowHeight of [64, 80]) assert.equal(overlayGeometry(source, { rowHeight, multiLane }), true);
  }
  assert.equal(overlayGeometry(source, { rowHeight: 88, multiLane: false }), true);
  assert.equal(overlayGeometry(source, { rowHeight: 89, multiLane: false }), false);
  assert.equal(overlayGeometry(source, { rowHeight: 120, multiLane: false }), false, 'legacy 120px non-bilingual remains separated');
  assert.equal(overlayGeometry(source, { mode: 'basic', clientHeight: 162 }), true);
  assert.equal(overlayGeometry(source, { mode: 'basic', clientHeight: 163 }), false);
  assert.equal(overlayGeometry(source, { mode: 'basic', contentHeight: 180 }), true);
  assert.equal(overlayGeometry(source, { mode: 'basic', contentHeight: 181 }), false);
}
test('overlay separation uses client-box height, both 3px gaps, 35px block and both insets; old threshold fails', () => {
  const source = read('editor/media/waveform/cue-blocks.js');
  checkOverlayThresholds(source);
  assert.throws(() => checkOverlayThresholds(source.replace(
    'rowHeightPx < resolvedOverlayBottom + 35 + inset',
    'rowHeightPx < (multiLane ? 50 + laneHeight * 2 : 84)',
  )), assert.AssertionError);
});

test('selection and marquee retain the original 2px outline without inward offsets', () => {
  const check = css => {
    const marquee = css.match(/\.waveform-cue-block\.marquee-preview \{[^}]*\}/)[0];
    const selected = css.match(/\.waveform-cue-block\.selected:hover \{[^}]*\}/)[0];
    assert.match(marquee, /outline: 2px dashed/);
    assert.match(selected, /outline: 2px solid/);
    assert.doesNotMatch(marquee + selected, /outline-offset/);
  };
  const css = read('waveform.css');
  check(css);
  assert.throws(() => check(css.replace('outline: 2px dashed var(--selection-yellow-line);',
    'outline: 2px dashed var(--selection-yellow-line); outline-offset: -1px;')), assert.AssertionError);
});

test('main track number includes the same gap as its lane; old badge offset fails', () => {
  const check = css => assert.match(css.match(/\.show-track-badges::before \{[^}]*\}/)[0], /lane-height\) \+ var\(--multi-subtitle-lane-gap\)/);
  const css = read('waveform.css');
  check(css);
  const mutated = css.replace(/(\.show-track-badges::before \{[^}]*?) \+ var\(--multi-subtitle-lane-gap\)/, '$1');
  assert.throws(() => check(mutated), assert.AssertionError);
});
