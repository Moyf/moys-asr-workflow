import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function canvasFixture() {
  const paint = [];
  const makeContext = () => new Proxy({
    letterSpacing: '0px',
    measureText(text) {
      return { width: text.length * 20, fontBoundingBoxAscent: 80, fontBoundingBoxDescent: 20 };
    },
    fillText(text) { paint.push({ mode: 'fill', text, color: this.fillStyle }); },
    strokeText(text) { paint.push({ mode: 'stroke', text, color: this.strokeStyle }); },
  }, { get(target, key) { return key in target ? target[key] : () => {}; } });
  const context = { window: {} };
  loadEditorModule(context, 'shared/editor-utils.js');
  context.window.MaweDom = { overlayEl: { prepend() {} } };
  context.window.MaweAppearance = { subtitleFontFamilyCss: () => 'sans-serif' };
  context.document = {
    createElement() { const ctx = makeContext(); return { getContext: () => ctx }; },
    fonts: { addEventListener() {} },
  };
  vm.runInNewContext(fs.readFileSync(new URL('../web/editor/styles/editor-wiring-ass-canvas.js', import.meta.url), 'utf8'), context);
  const style = context.window.AsrEditorUtils.normalizeAssStyle({ commentColor: '#111111', outline: 2, shadow: 0 });
  const track = { style, nativeFontSize: 72, runs: [{ text: 'comment', comment: true }] };
  const render = () => context.window.MaweAssCanvas.render({ playResX: 1920, playResY: 1080, tracks: [track] });
  return { paint, track, render };
}

test('changing the comment color repaints the cached line bitmap', () => {
  const { paint, track, render } = canvasFixture();
  render();
  assert.ok(paint.some(item => item.mode === 'fill' && item.color === '#111111'));
  paint.length = 0;
  track.style = { ...track.style, commentColor: '#ff0000' };
  render();
  assert.ok(paint.some(item => item.mode === 'fill' && item.color === '#ff0000'));
  // A subsequent unchanged frame should still reuse its rasterized bitmap.
  paint.length = 0;
  render();
  assert.equal(paint.length, 0);
});

test('changing comment text color to stroke color repaints both glyph layers', () => {
  const { paint, track, render } = canvasFixture();
  render();
  paint.length = 0;
  track.style = { ...track.style, commentStyle: 'stroke' };
  render();
  assert.ok(paint.some(item => item.mode === 'stroke' && item.color === '#111111'));
  assert.ok(paint.some(item => item.mode === 'fill' && item.color === track.style.primaryColor));
});
