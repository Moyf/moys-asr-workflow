import { editorInitializers } from './helpers/editor-entry.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const web = new URL('../web/', import.meta.url);

test('marker modules import without initializing browser state', async () => {
  const editing = await import('../web/editor/markers/editor-marker-editing.js');
  const panel = await import('../web/editor/markers/editor-markers-panel.js');
  assert.equal(editing.MaweMarkerEditing.getMarkers, editing.getMarkers);
  assert.equal(typeof panel.initMaweMarkersPanel, 'function');
});

test('marker ESM consumers use the editing module in production initialization order', () => {
  const files = editorInitializers.map(item => item.file);

  const targets = [
    ['editor/markers/editor-markers-panel.js', 'initMaweMarkersPanel'],
  ];
  assert.ok(!files.includes('editor/markers/editor-marker-editing.js'));
  for (const [file, exportName] of targets) {
    assert.ok(editorInitializers.some(module => module.file === file && module.exportName === exportName));
  }
  for (const file of [targets[0][0], 'editor/media/editor-waveform-init.js']) {
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
