import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';

function fixture() {
  const context = vm.createContext({document: {activeElement: null}});
  vm.runInContext(readFileSync(new URL('../web/editor/cues/editor-keyboard-targets.js', import.meta.url), 'utf8'), context);
  let blurred = 0;
  const control = {blur() {blurred += 1;}};
  const surface = {contains: element => element === control};
  const trigger = {contains: element => element === control};
  return {context, control, surface, trigger, blurred: () => blurred};
}

test('closing a surface releases focus from its hidden controls', () => {
  const {context, control, surface, blurred} = fixture();
  context.document.activeElement = control;
  context.MaweKeyboardTargets.releaseClosedUiFocus(surface);
  assert.equal(blurred(), 1);
});

test('closing a surface releases its trigger without focusing another button', () => {
  const {context, control, trigger, blurred} = fixture();
  context.document.activeElement = control;
  context.MaweKeyboardTargets.releaseClosedUiFocus({contains: () => false}, trigger);
  assert.equal(blurred(), 1);
});

test('closing another surface preserves unrelated input focus', () => {
  const {context, control, surface, trigger, blurred} = fixture();
  context.document.activeElement = {blur() {throw new Error('unrelated input must not blur');}};
  context.MaweKeyboardTargets.releaseClosedUiFocus(surface, trigger);
  assert.equal(blurred(), 0);
  context.document.activeElement = null;
  context.MaweKeyboardTargets.releaseClosedUiFocus(null);
  assert.equal(blurred(), 0);
  assert.ok(control);
});
