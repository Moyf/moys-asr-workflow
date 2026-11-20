import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { compileSources, readSources, readModules } from '../../scripts/build-editor.mjs';

const root = fileURLToPath(new URL('../../',import.meta.url));
const manifest = readSources(root), modules = readModules(root);
const fixtureDirectories = new Map([
  ['shared/editor-utils.js', ['shared/utils/']],
  ['editor/media/waveform.js', ['editor/media/waveform/']],
]);

// Cache only immutable compiled text, never a VM or its mutable globals.
// The compiler parameter lets the helper's own tests count real preparations.
export function createEditorModuleLoader(compile = compileSources) {
  const fixtures = new Map(), preparations = new Map();
  function prepareEditorModule(entry) {
    if (!fixtureDirectories.has(entry)) throw new Error(`Unknown editor fixture: ${entry}`);
    if (!preparations.has(entry)) {
      const pending = (async () => {
        const directories = fixtureDirectories.get(entry);
        const files = manifest.filter(name => name === 'editor/boot/editor-runtime.js'
          || name === 'editor/boot/editor-host.js' || name.startsWith('shared/host/')
          || name === 'shared/gap-remove-core.js' || name === entry
          || (entry === 'editor/media/waveform.js' && name === 'editor/media/editor-thumbnails.js')
          || directories.some(prefix => name.startsWith(prefix)));
        // Use the production translator with the fixture's DOM-free source slice.
        const built = await compile(root,files,modules.filter(item => files.includes(item.file)),
          file => fs.readFileSync(path.join(root,'web',file),'utf8'),{beforeEntry:entry});
        fixtures.set(entry,built.code);
      })().catch(error => {
        preparations.delete(entry);
        throw error;
      });
      preparations.set(entry,pending);
    }
    return preparations.get(entry);
  }

  function loadEditorModule(context, entry, beforeEntry = () => {}) {
    if (!fixtureDirectories.has(entry)) throw new Error(`Unknown editor fixture: ${entry}`);
    if (!fixtures.has(entry)) throw new Error(`Await prepareEditorModule(${JSON.stringify(entry)}) before loading`);
    context.__mawBeforeFixture = beforeEntry;
    try { vm.runInNewContext(fixtures.get(entry),context,{filename:entry}); }
    finally { delete context.__mawBeforeFixture; }
    return context.window;
  }
  return {prepareEditorModule, loadEditorModule};
}

export const {prepareEditorModule, loadEditorModule} = createEditorModuleLoader();
