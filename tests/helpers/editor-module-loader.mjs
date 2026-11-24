import vm from 'node:vm';
import { compileEditorFixture } from './editor-entry.mjs';

const fixtures = new Map(await Promise.all(['shared/editor-utils.js','editor/media/waveform.js'].map(async entry => {
  const files = ['shared/gap-remove-core.js', 'editor/boot/editor-host.js'];
  const utility = entry === 'shared/editor-utils.js';
  return [entry, await compileEditorFixture(
    utility ? [...files, entry, 'shared/utils/project-validation.js'] : [...files, entry],
    { beforeEntry: entry, exposed: utility ? {} : { waveformColors: 'editor/media/waveform/colors.js' } },
  )];
})));

export function loadEditorModule(context, entry, beforeEntry = () => {}) {
  if (!fixtures.has(entry)) throw new Error(`Unknown editor fixture: ${entry}`);
  context.__mawBeforeFixture = beforeEntry;
  try { vm.runInNewContext(fixtures.get(entry),context,{filename:entry}); }
  finally { delete context.__mawBeforeFixture; }
  return context.window;
}
