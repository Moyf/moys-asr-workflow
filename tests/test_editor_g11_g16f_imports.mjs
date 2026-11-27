import { editorInitializers } from './helpers/editor-entry.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'acorn';

const web = fileURLToPath(new URL('../web/', import.meta.url));

const g11 = [
  'io/editor-drag-drop.js', 'io/editor-dynamic-exports.js', 'io/editor-export-srt.js',
  'io/editor-export-timeline.js', 'io/editor-loading-progress.js',
  'io/editor-server-connection.js', 'io/editor-sticker-otio-export.js',
  'io/editor-sticker-root.js', 'media/editor-jkl.js', 'media/editor-media-load.js',
  'media/editor-media-playback.js', 'media/editor-media-step.js',
  'media/editor-playback-loop.js', 'media/editor-preview-geometry.js',
  'media/editor-sticker-overlay.js', 'media/editor-waveform-init.js',
].map(file => `editor/${file}`);
const g16f = [
  'editor-wiring-appearance-settings.js', 'editor-wiring-ass-canvas.js',
  'editor-wiring-ass-cue-position.js', 'editor-wiring-ass-frame.js',
  'editor-wiring-ass-manager.js', 'editor-wiring-ass-preview.js',
  'editor-wiring-ass-storage.js', 'editor-wiring-font-geometry.js',
].map(file => `editor/styles/${file}`);
const eager = new Map([
  ['editor/media/editor-media-load.js', 'MaweMediaLoad'],
  ['editor/media/editor-media-playback.js', 'MaweMediaPlayback'],
  ['editor/media/editor-media-step.js', 'MaweMediaStep'],
  ['editor/media/editor-playback-loop.js', 'MawePlaybackLoop'],
  ['editor/media/editor-preview-geometry.js', 'MawePreviewGeometry'],
  ['editor/media/editor-waveform-init.js', 'MaweWaveformInit'],
]);

test('G11 and G16-F keep explicitly initialized modules in the production entry', () => {
  const files = editorInitializers.map(item => item.file);
  for (const file of [...g11, ...g16f]) {
    if (eager.has(file)) {
      assert.ok(!files.includes(file), `${file} initializes during import`);
      continue;
    }
    const entry = editorInitializers.find(item => item.file === file);
    assert.equal(typeof entry.exportName, 'string');
    assert.ok(files.includes(file), `${file} missing from source order`);
  }
});

test('preview and style-library consumers have static provider edges', () => {
  const edges = new Map([
    ['editor/media/editor-playback-loop.js', 'editor/styles/editor-wiring-ass-preview.js'],
    ['editor/styles/editor-wiring-ass-manager.js', 'editor/styles/editor-wiring-ass-storage.js'],
    ['editor/styles/editor-wiring-ass-storage.js', 'editor/styles/editor-wiring-ass-manager.js'],
    ['editor/io/editor-export-srt.js', 'editor/styles/editor-wiring-ass-storage.js'],
  ]);
  for (const [consumer, provider] of edges) {
    const ast = parse(fs.readFileSync(path.join(web, consumer), 'utf8'), {
      ecmaVersion: 'latest', sourceType: 'module',
    });
    const expected = path.posix.relative(path.posix.dirname(consumer), provider);
    assert.ok(ast.body.some(node => node.type === 'ImportDeclaration'
      && path.posix.normalize(path.posix.join(path.posix.dirname(consumer), node.source.value)) === provider),
    `${consumer} must import ${expected}`);
  }
});

test('G11 and G16-F modules are safe to import before browser initialization', async () => {
  assert.equal(globalThis.window, undefined);
  for (const file of [...g11, ...g16f]) {
    const module = await import(`../web/${file}`);
    if (eager.has(file)) {
      assert.ok(Object.isFrozen(module[eager.get(file)]) && module[eager.get(file)], file);
      continue;
    }
    const initializer = editorInitializers.find(item => item.file === file).exportName;
    assert.equal(typeof module[initializer], 'function', file);
  }
});
