import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const web = new URL('../web/', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('editor-modules.json', web), 'utf8'));
const scripts = fs.readFileSync(new URL('editor-scripts.txt', web), 'utf8').trim().split('\n');
const targets = new Map([
  ['editor/boot/editor-wiring-initial-config.js', 'initMaweInitialConfigWiring'],
  ['editor/ui/editor-dom-panels.js', 'initMaweDomPanels'],
  ['editor/ui/editor-wiring-dom-panels.js', 'initMaweDomPanelsWiring'],
  ['editor/media/editor-ass-preview-refresh.js', 'initMaweAssPreviewRefresh'],
]);

test('G16-A/C initializers occupy their original startup slots', () => {
  for (const [file, exportName] of targets) {
    assert.ok(scripts.includes(file), file);
    const entry = manifest.modules.find(item => item.file === file);
    assert.equal(entry?.kind, 'init', file);
    assert.equal(entry?.exportName, exportName, file);
  }
  assert.ok(scripts.indexOf('editor/media/editor-ass-preview-refresh.js')
    < scripts.indexOf('editor/media/editor-wiring-keyboard-guards.js'));
  assert.ok(scripts.indexOf('editor/ui/editor-dom-panels.js')
    < scripts.indexOf('editor/ui/editor-wiring-dom-panels.js'));
  assert.ok(!manifest.externalBridges.some(item => item.file === 'editor/ui/editor-wiring-dom-panels.js'));
});

test('G16-A/C modules are inert on import', async () => {
  for (const [file, exportName] of targets) {
    const module = await import(new URL(file, web));
    assert.equal(typeof module[exportName], 'function', file);
  }
});

test('media and style consumers use the shared preview refresh interface', () => {
  const media = fs.readFileSync(new URL('editor/media/editor-media-playback.js', web), 'utf8');
  const style = fs.readFileSync(new URL('editor/styles/editor-wiring-font-geometry.js', web), 'utf8');
  assert.match(media, /import \{ observeAssSubtitlePreviewPlayer, scheduleAssSubtitlePreviewRefresh \} from '\.\/editor-ass-preview-refresh\.js';/);
  assert.match(style, /import \{ scheduleAssSubtitlePreviewRefresh \} from '\.\.\/media\/editor-ass-preview-refresh\.js';/);
  assert.doesNotMatch(media, /MaweKeyboardGuards\.(?:scheduleAssSubtitlePreviewRefresh|observeAssSubtitlePreviewPlayer)/);
  assert.doesNotMatch(style, /MaweKeyboardGuards\.scheduleAssSubtitlePreviewRefresh/);
});
