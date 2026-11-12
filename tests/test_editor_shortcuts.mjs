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
  assert.throws(() => api.setBinding('nav-a', 'Alt+Shift+e'), /Alt 派生组合冲突.*Alt\+Shift\+E/);
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
test('remapped navigation keys retain Alt drag-adjust semantics and suppress only old chords', () => {
  for (const [id, key, replacement] of [
    ['nav-a', 'a', 'e'], ['nav-d', 'd', 'p'], ['nav-w', 'w', 'y'], ['nav-s', 's', 'u'],
  ]) {
    const { api } = setup();
    api.setBinding(id, replacement);
    const entry = api.commands.find(item => item.id === id);
    const bindings = api.effectiveBindings(entry);
    assert.ok(bindings.some(binding => binding.chord === `Alt+${replacement}`
      && binding.target === `Alt+${key}`));
    const remapped = api.resolveEvent(event(replacement, { altKey: true }));
    assert.equal(remapped.key, key);
    assert.equal(remapped.altKey, true);
    assert.equal(api.resolveEvent(event(key, { altKey: true })).key, 'Unidentified');
  }
  const { api } = setup();
  api.setBinding('nav-a', 'e');
  assert.throws(() => api.setBinding('play', 'Alt+e'), /快捷键冲突/);
  assert.throws(() => api.setBinding('nav-a', 'Alt+e'), /Alt 派生组合冲突.*Alt\+E/);
  const extended = setup().api;
  extended.setBinding('extend-a', 'e');
  assert.ok(extended.effectiveBindings(extended.commands.find(item => item.id === 'extend-a'))
    .some(binding => binding.chord === 'Alt+e' && binding.target === 'Alt+Shift+a'));
  const remappedExtend = extended.resolveEvent(event('e', { altKey: true }));
  assert.equal(remappedExtend.key, 'a');
  assert.equal(remappedExtend.shiftKey, true);
  assert.equal(remappedExtend.altKey, true);
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
  assert.throws(() => api.setBinding('split', 'c'), /快捷键冲突.*字词选区合并/);
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
  api.setBinding('split', 'e');
  assert.equal(api.resolveEvent(event('b')).key, 'c');
  assert.equal(api.resolveEvent(event('e')).key, 'b');
  assert.throws(() => api.setBinding('split', null), /冲突/);
  api.setBinding('delete', 'p');
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
test('invalid saved split entries are dropped independently and valid saved commands survive later writes', () => {
  const { api, stored } = setup('{"split":["q"],"play":["p"]}');
  assert.deepEqual([...api.bindings(api.commands.find(item => item.id === 'split'))], ['b']);
  assert.deepEqual([...api.bindings(api.commands.find(item => item.id === 'play'))], ['p']);
  const warnings = api.takeSavedBindingWarnings();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].chord, /Ctrl\+Shift\+Q/);
  assert.match(warnings[0].reason, /Windows\/Linux Chromium/);

  api.setBinding('nav-d', 'y');
  const reloaded = setup(stored()).api;
  assert.deepEqual([...reloaded.bindings(reloaded.commands.find(item => item.id === 'play'))], ['p']);
  assert.deepEqual([...reloaded.bindings(reloaded.commands.find(item => item.id === 'nav-d'))], ['y']);
  assert.deepEqual([...reloaded.bindings(reloaded.commands.find(item => item.id === 'split'))], ['b']);
});
test('saved binding collisions are isolated so unrelated valid settings remain and each dropped entry is reported', () => {
  const { api } = setup('{"split":["q"],"merge":["b"],"play":["p"]}');
  assert.deepEqual([...api.bindings(api.commands.find(item => item.id === 'split'))], ['b']);
  assert.deepEqual([...api.bindings(api.commands.find(item => item.id === 'merge'))], ['c']);
  assert.deepEqual([...api.bindings(api.commands.find(item => item.id === 'play'))], ['p']);
  const warnings = api.takeSavedBindingWarnings();
  assert.equal(warnings.length, 2);
  assert.match(warnings[0].reason, /Ctrl\+Shift\+Q/);
  assert.equal(warnings[1].label, '合并选中字幕');
  assert.equal(warnings[1].reason, '快捷键冲突：');
  assert.equal(warnings[1].detail, '拆分字幕');
});
test('saved legal key exchanges are validated as a complete set before applying defaults', () => {
  const { api } = setup('{"play":["j"],"reverse":["p"]}');
  assert.deepEqual([...api.bindings(api.commands.find(item => item.id === 'play'))], ['j']);
  assert.deepEqual([...api.bindings(api.commands.find(item => item.id === 'reverse'))], ['p']);
  assert.equal(api.takeSavedBindingWarnings().length, 0);
  assert.equal(api.resolveEvent(event('j')).key, ' ');
  assert.equal(api.resolveEvent(event('p')).key, 'j');
});
test('saved custom collisions keep the first override and report the later discarded command', () => {
  const { api } = setup('{"play":["p"],"reverse":["p"]}');
  assert.deepEqual([...api.bindings(api.commands.find(item => item.id === 'play'))], ['p']);
  assert.deepEqual([...api.bindings(api.commands.find(item => item.id === 'reverse'))], ['j']);
  const [warning] = api.takeSavedBindingWarnings();
  assert.equal(warning.label, '倒放 / 降低速度');
  assert.equal(warning.reason, '快捷键冲突：');
  assert.equal(warning.detail, '播放 / 暂停');
});
test('invalid saved binding reports the unchanged default command that owns its chord', () => {
  const { api } = setup('{"play":["j"]}');
  assert.deepEqual([...api.bindings(api.commands.find(item => item.id === 'play'))], ['Space']);
  const [warning] = api.takeSavedBindingWarnings();
  assert.equal(warning.label, '播放 / 暂停');
  assert.equal(warning.reason, '快捷键冲突：');
  assert.equal(warning.detail, '倒放 / 降低速度');
});
test('fixed marker and contextual shortcuts cannot be reassigned onto another command', () => {
  const { api } = setup();
  assert.throws(() => api.setBinding('split', 'm'), /快捷键冲突.*标记编辑/);
  assert.throws(() => api.setBinding('split', 'q'), /Ctrl\+Shift\+Q/);
  assert.throws(() => api.setBinding('nav-a', 'q'), /快捷键冲突.*字词时间码/);
  api.setBinding('merge', 'e');
  assert.throws(() => api.setBinding('nav-a', 'c'), /快捷键冲突.*合并/);
  api.setBinding('preview', 'u');
  assert.throws(() => api.setBinding('nav-a', 'f'), /快捷键冲突.*字词选区试听/);
});
test('Shift+digits and macOS Option letters record usable chords', () => {
  const { api } = setup();
  assert.equal(api.chord(event('!', { code: 'Digit1', shiftKey: true })), 'Shift+1');
  assert.equal(api.chord(event('œ', { code: 'KeyQ', altKey: true })), 'Alt+q');
});
