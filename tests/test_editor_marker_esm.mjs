import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const web = new URL('../web/', import.meta.url);

test('marker modules import without initializing browser state', async () => {
  const editing = await import('../web/editor/markers/editor-marker-editing.js');
  const panel = await import('../web/editor/markers/editor-markers-panel.js');
  assert.equal(typeof editing.initMaweMarkerEditing, 'function');
  assert.equal(typeof panel.initMaweMarkersPanel, 'function');
});

test('marker ESM consumers use the editing module at their original ordered positions', () => {
  const files = readFileSync(new URL('editor-scripts.txt', web), 'utf8').trim().split('\n');
  const manifest = JSON.parse(readFileSync(new URL('editor-modules.json', web), 'utf8'));
  const targets = [
    ['editor/markers/editor-marker-editing.js', 'initMaweMarkerEditing'],
    ['editor/markers/editor-markers-panel.js', 'initMaweMarkersPanel'],
  ];
  assert.equal(files.indexOf(targets[1][0]), files.indexOf(targets[0][0]) + 1);
  for (const [file, exportName] of targets) {
    assert.ok(manifest.modules.some(module => module.file === file && module.kind === 'init'
      && module.exportName === exportName));
  }
  for (const file of [targets[1][0], 'editor/media/editor-waveform-init.js']) {
    const source = readFileSync(new URL(file, web), 'utf8');
    assert.match(source, /import \* as markerEditing from ['"][^'"]*editor-marker-editing\.js['"]/);
  }
  const importedEdges = [
    ['editor/state/editor-history.js', 'editor-marker-editing.js'],
    ['editor/io/editor-project-load.js', 'editor-marker-editing.js'],
    ['editor/io/editor-project-load.js', 'editor-markers-panel.js'],
    ['editor/ui/editor-settings-panels.js', 'editor-marker-editing.js'],
    ['editor/ui/editor-gap-remove-ui.js', 'editor-markers-panel.js'],
  ];
  for (const [consumer, target] of importedEdges) {
    assert.match(readFileSync(new URL(consumer, web), 'utf8'),
      new RegExp(`from ['"][^'"]*${target.replaceAll('.', '\\.')}['"]`));
  }
});
