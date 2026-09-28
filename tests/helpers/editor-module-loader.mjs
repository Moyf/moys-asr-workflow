import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const web = new URL('../../web/', import.meta.url);
const manifest = readFileSync(new URL('editor-scripts.txt', web), 'utf8')
  .split('\n').map(line => line.split('#')[0].trim()).filter(Boolean);

// ESM 试点：转换集不再以源码形态出现在清单中，清单上是它们的打包产物
// editor/boot/esm-bundle.js（classic IIFE，过期的判定在 test_esm_bundle_fresh）。
// 加载器因此无需特殊分支——产物就是一个普通清单条目， vm 按原位求值即可。

// Exercise the production order without constructing the full editor DOM.
export function loadEditorModule(context, entry, beforeEntry = () => {}) {
  const directories = entry === 'shared/editor-utils.js'
    ? ['shared/utils/'] : ['editor/media/waveform/'];
  const files = manifest.filter(name => name === 'editor/boot/editor-runtime.js'
    || name === 'editor/boot/esm-bundle.js' || name === 'shared/gap-remove-core.js'
    || name === entry || directories.some(prefix => name.startsWith(prefix)));
  for (const name of files) {
    if (name === entry) beforeEntry(context.window);
    vm.runInNewContext(readFileSync(new URL(name, web), 'utf8'), context, { filename: name });
  }
  return context.window;
}
