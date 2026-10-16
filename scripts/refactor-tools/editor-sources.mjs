// Developer tooling must enumerate the same sources as the builder.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

// 清单退役（批 4）：与 build-editor.deriveSources 同口径的目录推导。
export function editorScriptFiles(webDir) {
  return ['editor', 'shared'].flatMap((base) =>
    (function walk(dir) {
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        if (!entry.name.endsWith('.js')) return [];
        return [path.relative(webDir, full).replaceAll('\\', '/')];
      });
    })(path.join(webDir, base))
  ).filter((file) => !file.endsWith('.bundle.js')).sort();
}

// Historical mutation tools rebuild a single monolith and cannot safely
// replay into the continuous wiring slices. Refuse before writing anything.
export function requireLegacyEditor(webDir) {
  const files = editorScriptFiles(webDir);
  if (!existsSync(path.join(webDir, 'editor.js'))
      || files.some((file) => path.basename(file).startsWith('editor-wiring-'))) {
    throw new Error('This historical mutation tool requires the unsliced web/editor.js layout; use a legacy checkout. No files were written.');
  }
}
