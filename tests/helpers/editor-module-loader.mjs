import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as esbuild from 'esbuild';
import { CONVERTED } from './esm-pilot-converted.mjs';

const web = new URL('../../web/', import.meta.url);
// web URL 已带尾斜杠指向 web/ 目录本身；fileURLToPath 直接得到目录路径，
// 不能再套 dirname（会退到工作树根）。
const webDir = fileURLToPath(web);
const manifest = readFileSync(new URL('editor-scripts.txt', web), 'utf8')
  .split('\n').map(line => line.split('#')[0].trim()).filter(Boolean);

// ESM 试点：已转换文件无法再以 classic script 形态参与 vm 拼接。
// 处置与页面装配同构——用 esbuild 把转换集打成一个 classic IIFE，在它们
// 原本的清单位置整体注入。运行时共享全局的语义由 bundle 的 IIFE 外壳保持，
// 转换集内部的依赖则已是真实的 import 图。
let convertedBundleCode = null;
function convertedBundle() {
  if (convertedBundleCode === null) {
    const entry = `// 测试加载器专用：转换集入口（镜像页面装配）。\n`
      + CONVERTED.map(f => `import "../../${f}";\n`).join('')
      + `import { createEditorHost } from "../../editor/boot/editor-host.js";\n`
      + `window.MaweHost = createEditorHost({ browser: window, environment: globalThis });\n`;
    convertedBundleCode = esbuild.buildSync({
      stdin: { contents: entry, resolveDir: path.join(webDir, 'editor', 'boot'), loader: 'js' },
      bundle: true, format: 'iife', target: ['chrome120'], write: false,
    }).outputFiles[0].text;
  }
  return convertedBundleCode;
}

// Exercise the production order without constructing the full editor DOM.
export function loadEditorModule(context, entry, beforeEntry = () => {}) {
  const directories = entry === 'shared/editor-utils.js'
    ? ['shared/utils/'] : ['editor/media/waveform/'];
  const files = manifest.filter(name => name === 'editor/boot/editor-runtime.js'
    || name === 'editor/boot/editor-host.js' || name.startsWith('shared/host/')
    || name === 'shared/gap-remove-core.js' || name === entry
    || directories.some(prefix => name.startsWith(prefix)));
  let bundleInjected = false;
  for (const name of files) {
    if (CONVERTED.includes(name)) {
      // 转换集在清单中连续：在首个转换文件的位置整体注入 esbuild 产物。
      if (!bundleInjected) { vm.runInNewContext(convertedBundle(), context, { filename: 'esm-converted-bundle.js' }); bundleInjected = true; }
      continue;
    }
    if (name === entry) beforeEntry(context.window);
    vm.runInNewContext(readFileSync(new URL(name, web), 'utf8'), context, { filename: name });
  }
  return context.window;
}
