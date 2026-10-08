import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { compileSources, readSources, readModules } from '../../scripts/build-editor.mjs';

const root = fileURLToPath(new URL('../../',import.meta.url));
const manifest = readSources(root), modules = readModules(root);
const fixtures = new Map();
// Use the production translator with the fixture's DOM-free source slice.
// Behavior assertions and caller-provided dependency bags stay intact.
await Promise.all(['shared/editor-utils.js','editor/media/waveform.js'].map(async entry => {
  const directories = entry === 'shared/editor-utils.js' ? ['shared/utils/'] : ['editor/media/waveform/'];
  const files = manifest.filter(name => name === 'editor/boot/editor-runtime.js'
    || name === 'editor/boot/editor-host.js' || name.startsWith('shared/host/')
    || name === 'shared/gap-remove-core.js' || name === entry
    || directories.some(prefix => name.startsWith(prefix)));
  const built = await compileSources(root,files,modules.filter(item => files.includes(item.file)),
    file => fs.readFileSync(path.join(root,'web',file),'utf8'),{beforeEntry:entry});
  fixtures.set(entry,built.code);
}));

export function loadEditorModule(context, entry, beforeEntry = () => {}) {
  if (!fixtures.has(entry)) throw new Error(`Unknown editor fixture: ${entry}`);
  context.__mawBeforeFixture = beforeEntry;
  try { vm.runInNewContext(fixtures.get(entry),context,{filename:entry}); }
  finally { delete context.__mawBeforeFixture; }
  return context.window;
}
