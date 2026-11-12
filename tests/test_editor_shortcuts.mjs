import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initMaweShortcuts } from '../web/editor/cues/editor-shortcuts.js';
function setup(saved = '{}', denied = false) {
  let stored = saved;
  let modal = false;
  const context = {
    MaweHost: { storage: { getItem: () => stored, setItem: (_, value) => {
      if (denied) throw new Error('Storage denied');
      stored = value;
    } } },
    MaweKeyboardTargets: { isTextEditingTarget: event => !!event.editing },
    document: { querySelector: () => modal },
    navigator: { platform: 'Linux' },
  };
  context.window = context;
  globalThis.window = context;
  globalThis.MaweHost = context.MaweHost;
  globalThis.MaweKeyboardTargets = context.MaweKeyboardTargets;
  globalThis.document = context.document;
  initMaweShortcuts();
  return { api: context.MaweShortcuts, stored: () => stored, modal: value => { modal = value; } };
}
function event(key, flags = {}) { return { key, code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...flags }; }
test('all default commands survive validation and reset; aliases remain active', () => {
  const { api } = setup();
  api.setBinding('split', 'Alt+e');
  api.resetBindings();
  for (const entry of api.commands) for (const binding of entry.defaults) assert.equal(api.validChord(binding), true, binding);
  assert.equal(api.resolveEvent(event('Backspace')).key, 'Backspace');
  assert.equal(api.resolveEvent(event('y', { ctrlKey: true })).key, 'y');
});
test('palette shortcut defaults preserve 0 clear and all nine 2.0dev slots', () => {
  const { api } = setup();
  for (let slot = 0; slot <= 9; slot += 1) {
    const entry = api.commands.find(item => item.id === 'color-' + slot);
    assert.ok(entry, 'missing colour slot ' + slot);
    assert.deepEqual([...api.bindings(entry)], [String(slot)]);
    assert.equal(api.resolveEvent(event(String(slot))).key, String(slot));
  }
});
test('custom chords resolve to a single command and original keys stop firing', () => {
  const { api, stored } = setup();
  api.setBinding('split', 'e');
  const mapped = api.resolveEvent(event('E'));
  assert.equal(mapped.key, 'b');
  assert.equal(api.resolveEvent(event('b')).key, 'Unidentified');
  assert.equal(setup(stored()).api.resolveEvent(event('e')).key, 'b');
});
test('split operations preserve base modifiers and reject lossy or reserved variants before saving', () => {
  const { api, stored } = setup();
  api.setBinding('split', 'Alt+e');
  assert.deepEqual(api.effectiveBindings(api.commands.find(item => item.id === 'split')), [
    { chord: 'Alt+e', target: 'b' },
    { chord: 'Alt+Shift+e', target: 'Shift+b' },
    { chord: 'Mod+Alt+Shift+e', target: 'Mod+Shift+b' },
  ]);
  assert.throws(() => api.setBinding('nav-a', 'Alt+Shift+e'), /冲突：拆分字幕/);
  const savedAlt = stored();
  assert.throws(() => api.setBinding('split', 'Shift+e'), /派生组合发生冲突.*Shift\+E/);
  assert.equal(stored(), savedAlt);
  assert.throws(() => api.setBinding('split', 'Mod+Shift+e'), /派生组合发生冲突.*Ctrl\+Shift\+E/);
  assert.equal(stored(), savedAlt);
  assert.throws(() => api.setBinding('split', 'q'), error => {
    assert.match(error.message, /Ctrl\+Shift\+Q/);
    assert.match(error.message, /macOS/);
    assert.match(error.message, /Windows\/Linux Chromium/);
    assert.match(error.message, /ChromeOS/);
    return true;
  });
  assert.equal(stored(), savedAlt);

  assert.equal(api.validChord('Mod+h'), false);
  assert.throws(() => api.setBinding('nav-d', 'Mod+h'), error => {
    assert.match(error.message, /快捷键组合与系统或浏览器保留功能冲突/);
    assert.doesNotMatch(error.message, /派生组合/);
    return true;
  });
});
test('Alt-derived split variants dispatch each split operation to its target chord', () => {
  const { api } = setup();
  api.setBinding('split', 'Alt+e');
  const normal = api.resolveEvent(event('E', { altKey: true }));
  assert.equal(normal.key, 'b');
  assert.equal(normal.altKey, false);
  const progressive = api.resolveEvent(event('E', { altKey: true, shiftKey: true }));
  assert.equal(progressive.key, 'b');
  assert.equal(progressive.altKey, false);
  assert.equal(progressive.shiftKey, true);
  const duplicate = api.resolveEvent(event('E', { ctrlKey: true, altKey: true, shiftKey: true }));
  assert.equal(duplicate.key, 'b');
  assert.equal(duplicate.ctrlKey, true);
  assert.equal(duplicate.altKey, false);
  assert.equal(duplicate.shiftKey, true);
});
test('Mac hide shortcut is treated as reserved on every platform', () => {
  const { api } = setup();
  assert.equal(api.validChord('Mod+h'), false);
  assert.throws(() => api.setBinding('nav-d', 'Mod+h'), /Ctrl\+H/);
});
test('split mode variants follow the remapped base key and stay collision-protected', () => {
  const { api } = setup();
  assert.throws(() => api.setBinding('nav-a', 'Shift+b'), /冲突：拆分字幕/);
  assert.throws(() => api.setBinding('split', 'q'), /Ctrl\+Shift\+Q/);
  api.setBinding('split', 'e');
  const duplicate = api.resolveEvent(event('E', { ctrlKey: true, shiftKey: true }));
  assert.equal(duplicate.key, 'b');
  assert.equal(duplicate.ctrlKey, true);
  assert.equal(duplicate.shiftKey, true);
  assert.equal(api.resolveEvent(event('B', { shiftKey: true })).key, 'Unidentified');
  api.setBinding('nav-a', 'Shift+b');
  assert.equal(api.resolveEvent(event('B', { shiftKey: true })).key, 'a');
});
test('conflicting defaults/custom bindings and reserved keys preserve the saved state', () => {
  const { api, stored } = setup();
  assert.throws(() => api.setBinding('split', 'c'), /冲突：合并选中字幕/);
  assert.throws(() => api.setBinding('play', 'j'), /冲突：倒放/);
  assert.equal(stored(), '{}');
  api.setBinding('split', 'e');
  assert.throws(() => api.setBinding('merge', 'e'), /冲突/);
  assert.throws(() => api.setBinding('play', 'Mod+l'), /保留/);
  assert.equal(api.bindings(api.commands.find(item => item.id === 'split'))[0], 'e');
});
test('clear aliases, exchange keys, and reject a conflicting per-action reset', () => {
  const { api } = setup();
  api.setBinding('split', '');
  assert.equal(api.splitVariantLabel('b'), '');
  api.setBinding('merge', 'b');
  api.setBinding('split', 'c');
  assert.equal(api.resolveEvent(event('b')).key, 'c');
  assert.equal(api.resolveEvent(event('c')).key, 'b');
  assert.throws(() => api.setBinding('split', null), /冲突/);
  api.setBinding('delete', 'q');
  assert.equal(api.resolveEvent(event('Backspace')).key, 'Unidentified');
  assert.equal(api.resolveEvent(event('Delete')).key, 'Unidentified');
  assert.equal(api.resolveEvent(event('Delete', { shiftKey: true })).key, 'Unidentified');
});
test('typing, IME and modal input keep their own context; save also remaps while typing', () => {
  const { api, modal } = setup();
  api.setBinding('split', 'Alt+e');
  const typed = event('q', { editing: true });
  assert.equal(api.resolveEvent(typed), typed);
  assert.equal(api.resolveEvent(event('b', { isComposing: true })).key, 'Unidentified');
  api.setBinding('save', 'Mod+e');
  assert.equal(api.resolveEvent(event('e', { editing: true, ctrlKey: true })).key, 's');
  assert.equal(api.resolveEvent(event('s', { editing: true, ctrlKey: true })).key, 'Unidentified');
  api.setBinding('save', 'e');
  const typedSaveKey = event('e', { editing: true });
  assert.equal(api.resolveEvent(typedSaveKey), typedSaveKey);
  modal(true);
  const dialog = event('q');
  assert.equal(api.resolveEvent(dialog), dialog);
});
test('event methods use the original event and mapping stays stable across handlers', () => {
  const { api, modal } = setup();
  api.setBinding('split', 'Alt+e');
  const original = event('q', { preventDefault() { this.prevented = true; } });
  const mapped = api.resolveEvent(original);
  mapped.preventDefault();
  assert.equal(original.prevented, true);
  modal(true);
  assert.equal(api.resolveEvent(original), mapped);
});
test('corrupt stored bindings and unavailable storage safely preserve defaults', () => {
  for (const saved of ['{', '{"split":["c"]}', '{"split":"q"}', '{"split":["Escape"]}']) {
    const { api } = setup(saved);
    assert.equal(api.bindings(api.commands.find(item => item.id === 'split'))[0], 'b');
  }
  const { api } = setup('{}', true);
  assert.throws(() => api.setBinding('split', 'Alt+e'), /denied/);
  assert.equal(api.resolveEvent(event('b')).key, 'b');
});
test('Shift+digits and macOS Option letters record usable chords', () => {
  const { api } = setup();
  assert.equal(api.chord(event('!', { code: 'Digit1', shiftKey: true })), 'Shift+1');
  assert.equal(api.chord(event('œ', { code: 'KeyQ', altKey: true })), 'Alt+q');
});
