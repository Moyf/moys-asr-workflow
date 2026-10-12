import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createFileRegistry } = require('../src/file_registry.cjs');

function makeFs(files) {
  return {
    statSync(filePath) {
      if (!files.has(filePath)) throw new Error('missing');
      return { isFile: () => files.get(filePath) === 'file' };
    },
  };
}

test('file references are opaque, session-scoped, and type-checked', () => {
  const projectPath = path.resolve('字幕 工程.mosp');
  const mediaPath = path.resolve('素材 🎬.MP4');
  let id = 0;
  const registry = createFileRegistry({
    fs: makeFs(new Map([[projectPath, 'file'], [mediaPath, 'file']])),
    randomId: () => `ref-${++id}`,
  });
  const project = registry.register(projectPath, 'project');
  const media = registry.register(mediaPath, 'media');
  assert.equal(project.name, '字幕 工程.mosp');
  assert.equal(media.name, '素材 🎬.MP4');
  assert.equal(registry.get(project.id, 'project').path, projectPath);
  assert.equal(registry.get(project.id, 'media'), null);
  assert.throws(() => registry.register(mediaPath, 'project'), /工程文件/);
  registry.clear();
  assert.equal(registry.get(project.id), null);
});

test('file registry rejects directories, unknown types, and caps session references', () => {
  const projectPath = path.resolve('one.json');
  const mediaPath = path.resolve('two.wav');
  const registry = createFileRegistry({
    fs: makeFs(new Map([[projectPath, 'file'], [mediaPath, 'file'], [path.resolve('folder'), 'directory'], [path.resolve('readme.txt'), 'file']])),
    randomId: (() => { let id = 0; return () => `ref-${++id}`; })(),
    maxEntries: 1,
  });
  assert.throws(() => registry.register(path.resolve('folder')), /请选择文件/);
  assert.throws(() => registry.register(path.resolve('readme.txt')), /不支持/);
  const first = registry.register(projectPath);
  const second = registry.register(mediaPath);
  assert.equal(registry.size, 1);
  assert.equal(registry.get(first.id), null);
  assert.equal(registry.get(second.id).kind, 'media');
});
