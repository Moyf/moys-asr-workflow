import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { initModuleSource } from './helpers/init-module-source.mjs';

function harness() {
  const context = { document: { getElementById: () => null } };
  vm.runInNewContext(initModuleSource('editor/styles/editor-wiring-ass-frame.js'), context);
  const element = { hidden: true }, queued = [];
  let data = {}, mode = true, reads = 0;
  const warning = context.createAssEmojiWarning({ element,
    getData: () => { reads++; return data; }, isAssMode: () => mode,
    enqueue: fn => queued.push(fn) });
  return { element, warning, queued, setData: value => { data = value; },
    setMode: value => { mode = value; }, reads: () => reads };
}

test('all subtitle tracks are checked, including inactive tracks; ordinary kaomoji is not emoji', () => {
  const h = harness();
  for (const text of ['🤔', '👨‍👩‍👧', '🇨🇳', '1️⃣', '☀️']) {
    for (const data of [{ segments: [{ text }] }, { overlay_track: { segments: [{ text }] } },
      { multi_subtitle: { tracks: [{ segments: [] }, { segments: [{ text }] }] } }]) {
      h.setData(data); h.warning.sync(); assert.equal(h.element.hidden, false);
    }
  }
  h.setData({ segments: [{ text: '( •̀ ω •́ )y 123 # * (╬▔皿▔)╯' }] });
  h.warning.sync(); assert.equal(h.element.hidden, true);
});

test('mode changes, edits, undo/project replacement refresh without continuous scanning', () => {
  const h = harness();
  h.setData({ segments: [{ text: '🤔' }] });
  h.setMode(false); h.warning.sync(); assert.equal(h.element.hidden, true); assert.equal(h.reads(), 0);
  h.setMode(true); h.warning.sync(); assert.equal(h.element.hidden, false);
  for (let i = 0; i < 30; i++) h.warning.schedule();
  assert.equal(h.queued.length, 1); assert.equal(h.reads(), 1);
  h.setData({ segments: [{ text: 'removed' }] }); h.queued.shift()();
  assert.equal(h.element.hidden, true); assert.equal(h.reads(), 2);
  h.setData({ segments: [{ text: '🤔' }] }); h.warning.schedule(); h.queued.shift()();
  assert.equal(h.element.hidden, false);
});

test('warning is before camera, keyboard focusable, and tooltip does not promise monochrome output', () => {
  const html = fs.readFileSync(new URL('../web/editor-template.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('id="ass-emoji-warning"') < html.indexOf('id="ass-frame-quick-open"'));
  assert.match(html, /id="ass-emoji-warning"[^>]*tabindex="0"[^>]*aria-describedby="ass-emoji-warning-tip"/);
  assert.match(html, /可能只呈单色或缺字/);
  const css = fs.readFileSync(new URL('../web/editor.css', import.meta.url), 'utf8');
  assert.match(css, /\.ass-emoji-warning:focus \.ass-emoji-warning-tip/);
  const source = fs.readFileSync(new URL('../web/editor/styles/editor-wiring-ass-frame.js', import.meta.url), 'utf8');
  assert.ok(/function notifyProjectChanged\(\)\s*{\s*emojiWarning.schedule\(\)/.test(source), "project changes refresh the warning");
  assert.ok(/function syncAssFrameControls\(\)\s*{\s*emojiWarning.sync\(\)/.test(source), "mode controls refresh the warning");
});
