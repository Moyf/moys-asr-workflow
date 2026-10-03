import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Exercise the real inline-edit entry points with a controlled DOM/scheduler.
// Native focus has its own browser timing; this isolates the deferred repair
// contract, while browser save-in-flight tests cover actual typing and focus.
function fixture(kind) {
  const timers = [], root = new EventTarget();
  const textEl = { ownerDocument: root, firstChild: { textContent: 'Original' }, setAttribute() {}, focus() {} };
  Object.defineProperty(textEl, 'innerText', { get: () => textEl.firstChild.textContent,
    set: value => { textEl.firstChild = { textContent: value }; } });
  const el = { classList: { add() {} }, querySelector: () => textEl };
  const selection = { anchorNode: null, anchorOffset: 0, removeAllRanges() {},
    addRange(range) { this.anchorNode = range.node; this.anchorOffset = range.offset; } };
  const document = { createRange: () => ({
    setStart(node, offset) { this.node = node; this.offset = offset; },
    setEnd() {}, selectNodeContents(node) { this.node = node; this.offset = 0; },
  }) };
  const state = { editing: { editingState: null, extensionEditingState: null } };
  const context = { window: { getSelection: () => selection }, document,
    setTimeout: callback => timers.push(callback), MaweState: state,
    MaweNavPreview: { hideCueSplitPreview() {} }, MaweBoot: { DATA: { segments: [{ text: 'Original' }] } },
    MaweCuePanel: { setCurrentCuePanelExtensionIndex() {} } };
  vm.runInNewContext(readFileSync(new URL('../web/editor/cues/editor-inline-edit.js', import.meta.url), 'utf8'), context);
  const api = context.window.MaweInlineEdit;
  if (kind === 'main') api.startEdit(el, 0, undefined, undefined, { deferCaret: true });
  else api.startExtensionEdit(el, 0, { id: 'extension', segments: [{ text: 'Original' }] }, undefined, undefined, { deferCaret: true });
  return { root, timers, selection, textEl, state, el };
}

for (const kind of ['main', 'extension']) {
  test(`${kind}: untouched double-click repair still restores the intended caret`, () => {
    const { timers, selection } = fixture(kind);
    selection.anchorOffset = 4; // Native double-click selection has overwritten it.
    timers.forEach(callback => callback());
    assert.equal(selection.anchorOffset, 0);
  });

  for (const event of ['beforeinput', 'keydown', 'pointerdown']) {
    test(`${kind}: ${event} gives the new interaction ownership of the caret`, () => {
      const { root, timers, selection, textEl } = fixture(kind);
      root.dispatchEvent(new Event(event));
      textEl.firstChild.textContent = 'New user input';
      selection.anchorNode = textEl.firstChild;
      selection.anchorOffset = 7;
      timers.forEach(callback => callback());
      assert.equal(selection.anchorNode, textEl.firstChild);
      assert.equal(selection.anchorOffset, 7);
    });
  }

  test(`${kind}: a delayed callback cannot target a newer session on the same element`, () => {
    const { timers, selection, state, el } = fixture(kind);
    state.editing[kind === 'main' ? 'editingState' : 'extensionEditingState'] = { el };
    selection.anchorOffset = 5;
    timers.forEach(callback => callback());
    assert.equal(selection.anchorOffset, 5);
  });
}
