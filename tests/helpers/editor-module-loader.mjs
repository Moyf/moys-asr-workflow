import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const web = new URL('../../web/', import.meta.url);
const manifest = readFileSync(new URL('editor-scripts.txt', web), 'utf8')
  .split('\n').map(line => line.split('#')[0].trim()).filter(Boolean);

// Exercise the production order without constructing the full editor DOM.
export function loadEditorModule(context, entry) {
  const directories = entry === 'shared/editor-utils.js'
    ? ['shared/utils/'] : ['editor/media/waveform/'];
  const files = manifest.filter(name => name === 'editor/boot/editor-runtime.js'
    || name === 'editor/boot/editor-host.js' || name.startsWith('shared/host/')
    || name === 'shared/gap-remove-core.js' || name === entry
    || directories.some(prefix => name.startsWith(prefix)));
  for (const name of files) {
    vm.runInNewContext(readFileSync(new URL(name, web), 'utf8'), context, { filename: name });
  }
  return context.window;
}
