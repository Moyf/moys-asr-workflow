import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEditorModule, prepareEditorModule } from './helpers/editor-module-loader.mjs';

// 单句 ASS 样式「跟随样式库」的三个纯函数：内容键、跟随计划、旧句刷新计划。
// 应用（写回 segment、脏标记、渲染失效）在编辑器模块里，由 e2e 覆盖。
await prepareEditorModule('shared/editor-utils.js');

const context = { window: {} };
loadEditorModule(context, 'shared/editor-utils.js');
const h = context.window.AsrEditorUtils;

function makeStyle(overrides = {}) {
  return h.normalizeAssStyle({ id: 'red', name: '红色宋体', fontName: 'SimSun', primaryColor: '#ff0000', ...overrides });
}

function makeLibrary(styles) {
  return { styles: styles || [makeStyle()] };
}

function makeProject(style) {
  const saved = style ? JSON.parse(JSON.stringify(style)) : null;
  return {
    segments: [{ id: 'm1', start: 0, end: 1000, text: '主', assStyle: saved ? { ...saved } : null }],
    overlay_track: { segments: [{ id: 'o1', start: 0, end: 1000, text: '叠', assStyle: saved ? { ...saved } : null }] },
    multi_subtitle: { tracks: [{ segments: [{ id: 'e1', start: 0, end: 1000, text: '副', assStyle: saved ? { ...saved } : null }] }] },
  };
}

test('content key ignores name so a rename alone is not a content change', () => {
  const before = makeStyle({ name: '红色宋体' });
  const after = makeStyle({ name: '红宋' });
  assert.equal(h.assStyleContentKey(before), h.assStyleContentKey(after));
  assert.notEqual(h.assStyleContentKey(before), h.assStyleContentKey(makeStyle({ fontSize: before.fontSize + 2 })));
  assert.notEqual(h.assStyleContentKey(makeStyle()), h.assStyleContentKey(makeStyle({ id: 'blue' })));
});

test('cue groups cover main, overlay and multi-subtitle tracks', () => {
  const project = makeProject();
  const ids = h.assStyleCueGroups(project).map(group => group.map(segment => segment.id));
  assert.equal(JSON.stringify(ids), JSON.stringify([['m1'], ['o1'], ['e1']]));
});

test('planAssStyleCueSync follows matching cues on every track', () => {
  const before = makeStyle();
  const after = makeStyle({ fontSize: before.fontSize + 4 });
  const project = makeProject(before);
  const { updates, changed } = h.planAssStyleCueSync(h.assStyleCueGroups(project), makeLibrary([before]), makeLibrary([after]), new Map());
  assert.equal(changed.size, 1);
  assert.ok(changed.get('red'));
  assert.equal(updates.length, 3);
  for (const { segment, style } of updates) {
    assert.equal(style.fontSize, after.fontSize);
    assert.equal(segment.assStyle.id, 'red');
  }
  // 纯函数不改写句子；应用由调用方完成。
  assert.equal(project.segments[0].assStyle.fontSize, before.fontSize);
});

test('planAssStyleCueSync ignores rename-only edits', () => {
  const before = makeStyle({ name: '红色宋体' });
  const after = makeStyle({ name: '红宋' });
  const project = makeProject(before);
  const { updates, changed } = h.planAssStyleCueSync(h.assStyleCueGroups(project), makeLibrary([before]), makeLibrary([after]), new Map());
  assert.equal(changed.size, 0);
  assert.equal(updates.length, 0);
});

test('planAssStyleCueSync follows a content edit after a rename', () => {
  // 句子在改名前选了样式（快照带旧名）；库改名后再改内容：
  // raw 与改前库不等，但内容键相等，必须跟随。
  const saved = makeStyle({ name: '红色宋体' });
  const renamed = makeStyle({ name: '红宋' });
  const edited = makeStyle({ name: '红宋', fontSize: renamed.fontSize + 4 });
  assert.equal(h.assStyleContentKey(saved), h.assStyleContentKey(renamed));
  assert.notEqual(JSON.stringify(saved), JSON.stringify(renamed));
  const project = makeProject(saved);
  const { updates } = h.planAssStyleCueSync(h.assStyleCueGroups(project), makeLibrary([renamed]), makeLibrary([edited]), new Map());
  assert.equal(updates.length, 3);
  for (const { style } of updates) assert.equal(style.fontSize, edited.fontSize);
});

test('planAssStyleCueSync skips cues saved before the session but lists them for refresh', () => {
  const stale = makeStyle({ fontSize: 30 });
  const before = makeStyle();
  const after = makeStyle({ fontSize: before.fontSize + 4 });
  const project = makeProject(stale);
  const groups = h.assStyleCueGroups(project);
  const { updates } = h.planAssStyleCueSync(groups, makeLibrary([before]), makeLibrary([after]), new Map());
  assert.equal(updates.length, 0);
  const refresh = h.planAssStyleCueRefresh(groups, makeLibrary([after]));
  assert.equal(refresh.length, 3);
});

test('planAssStyleCueSync follows a session-restored snapshot recorded in seen', () => {
  const restored = makeStyle({ fontSize: 30 });
  const before = makeStyle();
  const after = makeStyle({ fontSize: before.fontSize + 4 });
  const seen = new Map([['red', new Set([h.assStyleContentKey(restored)])]]);
  const project = makeProject(restored);
  const { updates } = h.planAssStyleCueSync(h.assStyleCueGroups(project), makeLibrary([before]), makeLibrary([after]), seen);
  assert.equal(updates.length, 3);
});

test('deleted styles keep their saved snapshots out of every plan', () => {
  const saved = makeStyle();
  const other = makeStyle({ id: 'blue', name: '蓝体' });
  const project = makeProject(saved);
  const groups = h.assStyleCueGroups(project);
  const sync = h.planAssStyleCueSync(groups, makeLibrary([saved]), makeLibrary([other]), new Map());
  assert.equal(sync.updates.length, 0);
  assert.equal(sync.changed.size, 0);
  assert.equal(h.planAssStyleCueRefresh(groups, makeLibrary([other])).length, 0);
  assert.equal(h.planAssStyleCueFollow(groups, makeLibrary([other]), new Map([['red', new Set([h.assStyleContentKey(saved)])]])).length, 0);
});

test('planAssStyleCueFollow re-aligns seen snapshots only', () => {
  const before = makeStyle();
  const after = makeStyle({ fontSize: before.fontSize + 4 });
  const seen = new Map([['red', new Set([h.assStyleContentKey(before)])]]);
  const project = makeProject(before);
  const groups = h.assStyleCueGroups(project);
  // 项目里额外放一条从未跟随过的旧句子（未被 seen 记录）。
  project.segments.push({ id: 'm2', start: 1000, end: 2000, text: '旧', assStyle: makeStyle({ fontSize: 20 }) });
  project.segments.push({ id: 'm3', start: 2000, end: 3000, text: '新', assStyle: makeStyle({ fontSize: after.fontSize }) });
  const updates = h.planAssStyleCueFollow(groups, makeLibrary([after]), seen);
  assert.equal(JSON.stringify(updates.map(update => update.segment.id)), JSON.stringify(['m1', 'o1', 'e1']));
  for (const { style } of updates) assert.equal(style.fontSize, after.fontSize);
  // 未命中 seen 时同一个句子不会被重对齐。
  const untouched = h.planAssStyleCueFollow(groups, makeLibrary([after]), new Map());
  assert.equal(untouched.length, 0);
});

test('new and duplicated styles do not affect any cue', () => {
  const before = makeStyle();
  const fresh = makeStyle({ id: 'fresh', name: '新样式' });
  const project = makeProject(before);
  const { updates, changed } = h.planAssStyleCueSync(h.assStyleCueGroups(project), makeLibrary([before]), makeLibrary([before, fresh]), new Map());
  assert.equal(changed.size, 0);
  assert.equal(updates.length, 0);
});
