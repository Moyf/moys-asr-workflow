import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initMaweShortcuts } from '../web/editor/cues/editor-shortcuts.js';
function setup(saved = '{}', denied = false, platform = 'Linux') {
  let stored = saved;
  let modal = false;
  let modalSelector = '';
  const context = {
    MaweHost: { storage: { getItem: () => stored, setItem: (_, value) => {
      if (denied) throw new Error('Storage denied');
      stored = value;
    } } },
    MaweKeyboardTargets: { isTextEditingTarget: event => !!event.editing },
    document: { querySelector: selector => { modalSelector = selector; return modal; } },
    navigator: { platform },
  };
  context.window = context;
  globalThis.window = context;
  globalThis.MaweHost = context.MaweHost;
  globalThis.MaweKeyboardTargets = context.MaweKeyboardTargets;
  globalThis.document = context.document;
  initMaweShortcuts();
  return { api: context.MaweShortcuts, stored: () => stored, modal: value => { modal = value; }, modalSelector: () => modalSelector };
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
test('split operations preserve base modifiers and reject lossy or internally conflicting variants', () => {
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
  assert.throws(() => api.setBinding('split', 'q'), /快捷键冲突.*字词时间码/);
  assert.equal(stored(), savedAlt);
  api.setBinding('nav-d', 'Mod+h');
  assert.equal(api.validChord('Mod+h'), true);
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
test('remapped boundary snap retains Alt+Shift variants and suppresses their old chord', () => {
  const { api } = setup();
  api.setBinding('snap-ArrowLeft', 'e');
  const entry = api.commands.find(item => item.id === 'snap-ArrowLeft');
  assert.deepEqual(api.effectiveBindings(entry), [
    { chord: 'e', target: 'Shift+ArrowLeft' },
    { chord: 'Alt+e', target: 'Alt+Shift+ArrowLeft' },
  ]);
  const mapped = api.resolveEvent(event('e', { altKey: true }));
  assert.equal(mapped.key, 'ArrowLeft');
  assert.equal(mapped.altKey, true);
  assert.equal(mapped.shiftKey, true);
  assert.equal(api.resolveEvent(event('ArrowLeft', { altKey: true, shiftKey: true })).key, 'Unidentified');
  assert.throws(() => api.setBinding('seek-ArrowLeft', 'Alt+e'), /快捷键冲突/);
});
test('overridden global chords are suppressed while a modal keeps its physical event', () => {
  const { api, modal } = setup('{"reverse":["p"]}');
  modal(true);
  const oldEvent = event('j');
  assert.equal(api.resolveEvent(oldEvent).key, 'Unidentified');
  assert.equal(oldEvent.key, 'j');
  const newEvent = event('p');
  assert.equal(api.resolveEvent(newEvent).key, 'Unidentified');
  assert.equal(newEvent.key, 'p');
});
test('native open dialogs guard remapped global chords and preserve local physical events', () => {
  const { api, modal, modalSelector } = setup('{"delete":["F2"]}');
  modal(true);
  const remapped = event('F2');
  assert.equal(api.resolveEvent(remapped).key, 'Unidentified');
  assert.equal(remapped.key, 'F2');
  assert.equal(api.resolveEvent(event('Delete')).key, 'Unidentified');
  assert.match(modalSelector(), /dialog\[open\]/);
});
test('system and browser keys can be bound on each platform without losing migration', () => {
  for (const platform of ['MacIntel', 'Win32']) {
    for (const key of ['Mod+h', 'Mod+r', 'F5', 'Mod+Space', 'Mod+Shift+3']) {
      const { api, stored } = setup('{}', false, platform);
      assert.equal(api.validChord(key), true, key);
      api.setBinding('nav-d', key);
      const migrated = setup(stored(), false, platform).api;
      assert.deepEqual([...migrated.bindings(migrated.commands.find(item => item.id === 'nav-d'))], [key]);
      assert.deepEqual(migrated.takeSavedBindingWarnings(), []);
    }
  }
});
test('split mode variants follow the remapped base key and stay collision-protected', () => {
  const { api } = setup();
  assert.throws(() => api.setBinding('nav-a', 'Shift+b'), /冲突：拆分字幕/);
  assert.throws(() => api.setBinding('split', 'q'), /快捷键冲突.*字词时间码/);
  api.setBinding('split', 'e');
  const duplicate = api.resolveEvent(event('E', { ctrlKey: true, shiftKey: true }));
  assert.equal(duplicate.key, 'b');
  assert.equal(duplicate.ctrlKey, true);
  assert.equal(duplicate.shiftKey, true);
  assert.equal(api.resolveEvent(event('B', { shiftKey: true })).key, 'Unidentified');
  api.setBinding('nav-a', 'Shift+b');
  assert.equal(api.resolveEvent(event('B', { shiftKey: true })).key, 'a');
});
test('conflicting defaults and custom bindings are rejected while system keys are allowed', () => {
  const { api, stored } = setup();
  assert.throws(() => api.setBinding('split', 'c'), /快捷键冲突.*字词选区合并/);
  assert.throws(() => api.setBinding('play', 'j'), /冲突：倒放/);
  assert.equal(stored(), '{}');
  api.setBinding('split', 'e');
  assert.throws(() => api.setBinding('merge', 'e'), /冲突/);
  api.setBinding('play', 'Mod+l');
  assert.equal(api.bindings(api.commands.find(item => item.id === 'play'))[0], 'Mod+l');
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
  assert.equal(api.resolveEvent(dialog).key, 'Unidentified');
  assert.equal(dialog.key, 'q');
});
test('Mod+S saves inline edits without stealing a different non-editing binding', () => {
  const { api } = setup();
  api.setBinding('save', 'F2');
  api.setBinding('merge', 'Mod+s');
  const outside = api.resolveEvent(event('s', { ctrlKey: true }));
  assert.equal(outside.key, 'c');
  window.MaweInlineEdit = { editingState: {} };
  const editingSave = event('s', { ctrlKey: true, editing: true });
  assert.equal(api.resolveEvent(editingSave), editingSave);
  window.MaweInlineEdit = { extensionEditingState: {} };
  const extensionSave = event('s', { metaKey: true, editing: true });
  assert.equal(api.resolveEvent(extensionSave), extensionSave);
  const cuePanelText = {};
  window.MaweInlineEdit = {};
  window.MaweDom = { cuePanelText };
  const panelSave = event('s', { ctrlKey: true, editing: true, target: cuePanelText });
  assert.equal(api.resolveEvent(panelSave), panelSave);
  const migrated = setup('{"save":["F2"],"merge":["Mod+s"]}');
  assert.deepEqual(migrated.api.bindings(migrated.api.commands.find(item => item.id === 'merge')), ['Mod+s']);
  assert.deepEqual(migrated.api.takeSavedBindingWarnings(), []);
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
  assert.equal(warnings[0].chord, 'q');
  assert.equal(warnings[0].reason, '快捷键冲突：');
  assert.match(warnings[0].detail, /字词时间码/);

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
  assert.equal(warnings[0].reason, '快捷键冲突：');
  assert.match(warnings[0].detail, /字词时间码/);
  assert.equal(warnings[1].label, '合并选中字幕');
  assert.equal(warnings[1].reason, '快捷键冲突：');
  assert.equal(warnings[1].detail, '拆分字幕');
});
test('saved Shift+E split variant collision is structured and keeps unrelated play binding', () => {
  const { api } = setup('{"split":["Shift+e"],"play":["p"]}');
  assert.deepEqual([...api.bindings(api.commands.find(item => item.id === 'split'))], ['b']);
  assert.deepEqual([...api.bindings(api.commands.find(item => item.id === 'play'))], ['p']);
  assert.deepEqual(api.takeSavedBindingWarnings(), [{
    label: '拆分字幕', chord: 'Shift+E',
    reason: '拆分快捷键派生组合发生冲突，无法区分三种拆分操作：',
  }]);
});
test('saved Alt+Shift navigation derived collision is structured and keeps unrelated play binding', () => {
  const { api } = setup('{"nav-a":["Alt+Shift+e"],"play":["p"]}');
  assert.deepEqual([...api.bindings(api.commands.find(item => item.id === 'nav-a'))], ['a']);
  assert.deepEqual([...api.bindings(api.commands.find(item => item.id === 'play'))], ['p']);
  assert.deepEqual(api.takeSavedBindingWarnings(), [{
    label: '上一条字幕（横向）', chord: 'Alt+Shift+E',
    reason: '键盘快捷键的 Alt 派生组合冲突，无法保留原修饰键语义：',
  }]);
});
test('clipboard bindings are reserved during migration and retain legal siblings', () => {
  for (const platform of ['MacIntel', 'Win32']) {
    const { api } = setup('{"delete":["Mod+c","F2"],"merge":["Mod+v","F3"],"add":["Mod+x","F4"],"play":["p"]}', false, platform);
    for (const [id, expected] of [['delete', 'F2'], ['merge', 'F3'], ['add', 'F4'], ['play', 'p']]) {
      assert.deepEqual([...api.bindings(api.commands.find(item => item.id === id))], [expected]);
    }
    const warnings = api.takeSavedBindingWarnings();
    assert.equal(warnings.length, 3);
    for (const warning of warnings) assert.equal(warning.reason, '快捷键保留给复制、粘贴和剪切');
  }
});
test('invalid and internally conflicting saved siblings retain the valid chord', () => {
  for (const value of [['Bogus', 'F2'], ['F2', 'Bogus']]) {
    const { api } = setup(JSON.stringify({ delete: value }));
    assert.deepEqual([...api.bindings(api.commands.find(item => item.id === 'delete'))], ['F2']);
    assert.equal(api.takeSavedBindingWarnings().length, 1);
  }
  const { api } = setup(JSON.stringify({ split: ['F2', 'Shift+F2'] }));
  assert.deepEqual([...api.bindings(api.commands.find(item => item.id === 'split'))], ['F2']);
  assert.equal(api.takeSavedBindingWarnings().length, 1);
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
  assert.throws(() => api.setBinding('split', 'q'), /快捷键冲突.*字词时间码/);
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


test('modal projection suppresses global consumers for all keys and modifiers while leaving the original event intact', () => {
  const { api, modal } = setup();
  modal(true);
  const keys = ['Delete', 'Backspace', 'j', 'k', 'l', ' ', 'g', 'ArrowLeft', 'ArrowRight', 'Home', 'End',
    'F2', 'a', 'b', 'c', 't', 'v', 'n', 'r', '0', '1', 'i', 'o', 'h', 'z', 'y', 'x', 'ArrowUp', 'ArrowDown'];
  for (const key of keys) for (let bits = 0; bits < 16; bits++) {
    const original = event(key, { ctrlKey: !!(bits & 1), metaKey: !!(bits & 2), altKey: !!(bits & 4), shiftKey: !!(bits & 8) });
    const resolved = api.resolveEvent(original);
    assert.equal(resolved.key, 'Unidentified', `${key} modifier mask ${bits}`);
    assert.equal(original.key, key);
  }
  const escape = event('Escape');
  assert.equal(api.resolveEvent(escape), escape);
});


test('remapped save chords do not execute during subtitle text editing', () => {
  for (const surface of ['inline', 'extension', 'panel']) {
    const { api } = setup();
    api.setBinding('save', 'Mod+e');
    api.setBinding('save-as', 'Mod+Shift+e');
    const panel = {};
    window.MaweDom = { cuePanelText: panel };
    window.MaweInlineEdit = surface === 'inline' ? { editingState: {} }
      : surface === 'extension' ? { extensionEditingState: {} } : {};
    const target = surface === 'panel' ? panel : {};
    for (const shiftKey of [false, true]) {
      const original = event('e', { ctrlKey: true, shiftKey, editing: true, target });
      assert.equal(api.resolveEvent(original).key, 'Unidentified', surface);
      assert.equal(original.key, 'e');
    }
    const physicalSave = event('s', { ctrlKey: true, editing: true, target });
    assert.equal(api.resolveEvent(physicalSave), physicalSave);
    window.MaweInlineEdit = {};
    assert.equal(api.resolveEvent(event('e', { ctrlKey: true })).key, 's');
  }
});


test('playback and deletion preserve shifted variants and reserve them against collisions', () => {
  for (const [id, replacement, oldKey, target] of [
    ['play', 'F7', ' ', 'Space'], ['reverse', 'F2', 'j', 'j'],
    ['stop', 'F3', 'k', 'k'], ['forward', 'F4', 'l', 'l'],
    ['delete', 'F6', 'Delete', 'Delete'],
  ]) {
    const { api } = setup();
    api.setBinding(id, replacement);
    const binding = api.effectiveBindings(api.commands.find(item => item.id === id));
    assert.ok(binding.some(item => item.chord === `Shift+${replacement}` && item.target === `Shift+${target}`));
    const mapped = api.resolveEvent(event(replacement, { shiftKey: true }));
    assert.equal(mapped.key, target === 'Space' ? ' ' : target);
    assert.equal(mapped.shiftKey, true);
    assert.equal(api.resolveEvent(event(oldKey, { shiftKey: true })).key, 'Unidentified');
    assert.throws(() => api.setBinding('preview', `Shift+${replacement}`), /快捷键冲突/);
  }
  const { api } = setup();
  api.setBinding('reverse', 'Shift+F2');
  assert.equal(api.resolveEvent(event('F2', { shiftKey: true })).key, 'j');
  assert.throws(() => api.setBinding('preview', 'Shift+F2'), /快捷键冲突/);
});


test('previously saved shifted playback collisions fall back with a warning', () => {
  const { api } = setup('{"reverse":["F2"],"preview":["Shift+F2"],"play":["F7"]}');
  assert.deepEqual([...api.bindings(api.commands.find(item => item.id === 'reverse'))], ['F2']);
  assert.deepEqual([...api.bindings(api.commands.find(item => item.id === 'preview'))], ['f']);
  assert.deepEqual([...api.bindings(api.commands.find(item => item.id === 'play'))], ['F7']);
  const warnings = api.takeSavedBindingWarnings();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].label, '跳转并播放选中字幕');
  assert.match(warnings[0].detail, /倒放/);
});


test('saved playback aliases with the same shifted action remain valid', () => {
  const { api } = setup('{"reverse":["F2","Shift+F2"]}');
  assert.deepEqual([...api.bindings(api.commands.find(item => item.id === 'reverse'))], ['F2', 'Shift+F2']);
  assert.equal(api.takeSavedBindingWarnings().length, 0);
  assert.equal(api.resolveEvent(event('F2', { shiftKey: true })).key, 'j');
});


test('history modifier variants follow remaps and participate in conflict checks', () => {
  const { api } = setup();
  api.setBinding('undo', 'F2');
  api.setBinding('redo', 'F3');
  for (const [key, flags, target, shift] of [
    ['F2', { altKey: true }, 'z', false],
    ['F3', { altKey: true }, 'z', true],
    ['F3', { shiftKey: true }, 'z', true],
    ['F3', { altKey: true, shiftKey: true }, 'z', true],
  ]) {
    const mapped = api.resolveEvent(event(key, flags));
    assert.equal(mapped.key, target);
    assert.equal(mapped.shiftKey, shift);
    assert.equal(mapped.ctrlKey, true);
  }
  assert.equal(api.resolveEvent(event('z', { ctrlKey: true, altKey: true })).key, 'Unidentified');
  assert.equal(api.resolveEvent(event('y', { ctrlKey: true, shiftKey: true })).key, 'Unidentified');
  assert.throws(() => api.setBinding('preview', 'Alt+F2'), /快捷键冲突/);
  assert.throws(() => api.setBinding('preview', 'Shift+F3'), /快捷键冲突/);
});

test('history remaps retain system variants and preserve equivalent saved aliases', () => {
  const { api } = setup('{"undo":["F2","Alt+F2"]}');
  assert.deepEqual([...api.bindings(api.commands.find(item => item.id === 'undo'))], ['F2', 'Alt+F2']);
  assert.equal(api.takeSavedBindingWarnings().length, 0);
  api.setBinding('redo', 'F4');
  assert.ok(api.effectiveBindings(api.commands.find(item => item.id === 'redo')).some(item => item.chord === 'Alt+F4'));
  assert.equal(api.resolveEvent(event('F4', { altKey: true })).key, 'z');
});


test('arrow chords are reserved for their original commands even when cleared', () => {
  const { api } = setup();
  api.setBinding('track-up', '');
  for (const chord of ['ArrowUp', 'Shift+ArrowUp', 'Alt+ArrowDown', 'Mod+ArrowLeft', 'Mod+Alt+Shift+ArrowRight']) {
    assert.throws(() => api.setBinding('delete', chord), /方向键保留给原有方向键操作/);
  }
  assert.throws(() => api.setBinding('track-up', 'ArrowDown'), /方向键保留给原有方向键操作/);
  api.setBinding('track-up', 'ArrowUp');
  api.setBinding('snap-ArrowLeft', null);
  assert.equal(api.resolveEvent(event('ArrowLeft', { altKey: true, shiftKey: true })).key, 'ArrowLeft');
});

test('invalid saved arrow assignment is ignored while other overrides survive', () => {
  const { api } = setup(JSON.stringify({ 'track-up': [], delete: ['ArrowUp'], play: ['p'] }));
  assert.deepEqual(api.bindings(api.commands.find(entry => entry.id === 'delete')), ['Delete', 'Backspace']);
  assert.deepEqual(api.bindings(api.commands.find(entry => entry.id === 'play')), ['p']);
  assert.match(api.takeSavedBindingWarnings()[0].reason, /方向键/);
});

test('local arrow controls keep the original event while global consumers see no shortcut', () => {
  const { api } = setup();
  for (const selector of ['#ass-cue-position', '.ass-cue-drag-target', '.geo-box', '.editor-settings-nav-tab']) {
    const original = event('ArrowUp', { target: { closest: value => value.includes(selector) } });
    assert.equal(api.resolveEvent(original).key, 'Unidentified');
    assert.equal(original.key, 'ArrowUp');
  }
  assert.equal(api.resolveEvent(event('ArrowUp')).key, 'ArrowUp');
});


test('invalid saved arrows do not discard a valid sibling binding', () => {
  const { api } = setup(JSON.stringify({ 'track-up': [], delete: ['ArrowUp', 'F2'], play: ['p'] }));
  assert.deepEqual(api.bindings(api.commands.find(entry => entry.id === 'delete')), ['F2']);
  assert.equal(api.resolveEvent(event('F2')).key, 'Delete');
  assert.match(api.takeSavedBindingWarnings()[0].reason, /方向键/);
});


test('settings button Enter stays local even if the physical key is reassigned', () => {
  const { api } = setup();
  api.setBinding('edit', '');
  api.setBinding('delete', 'Enter');
  const button = { closest: selector => selector.includes('#editor-settings-toggle') };
  const original = event('Enter', { target: button });
  assert.equal(api.resolveEvent(original).key, 'Unidentified');
  assert.equal(original.key, 'Enter');
  assert.equal(api.resolveEvent(event('Enter')).key, 'Delete');
});


test('exact clipboard chords are reserved but unrelated modifiers and defaults remain available', () => {
  for (const platform of ['MacIntel', 'Win32']) {
    for (const key of ['Mod+c', 'Mod+v', 'Mod+x']) {
      const { api, stored } = setup('{}', false, platform);
      assert.equal(api.validChord(key), true);
      assert.throws(() => api.setBinding('delete', key), /保留给复制、粘贴和剪切/);
      assert.equal(stored(), '{}');
      for (const id of ['undo', 'redo', 'select-all']) {
        assert.deepEqual([...api.bindings(api.commands.find(item => item.id === id))], [...api.commands.find(item => item.id === id).defaults]);
      }
    }
    for (const key of ['Mod+Shift+c', 'Mod+Alt+v', 'Mod+Shift+x']) {
      const { api } = setup('{}', false, platform);
      api.setBinding('delete', key);
      assert.deepEqual([...api.bindings(api.commands.find(item => item.id === 'delete'))], [key]);
    }
  }
});

test('saved cross-command and derived conflicts drop only the conflicting sibling', () => {
  const direct = setup('{"play":["p"],"delete":["F2","p"]}').api;
  assert.deepEqual([...direct.bindings(direct.commands.find(item => item.id === 'delete'))], ['F2']);
  assert.deepEqual([...direct.bindings(direct.commands.find(item => item.id === 'play'))], ['p']);
  assert.equal(direct.takeSavedBindingWarnings().length, 1);
  const derived = setup('{"play":["Shift+F3"],"delete":["F2","F3"]}').api;
  assert.deepEqual([...derived.bindings(derived.commands.find(item => item.id === 'delete'))], ['F2']);
  assert.deepEqual([...derived.bindings(derived.commands.find(item => item.id === 'play'))], ['Shift+F3']);
  assert.equal(derived.takeSavedBindingWarnings().length, 1);
});
