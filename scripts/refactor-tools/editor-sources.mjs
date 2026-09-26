// Developer tooling must enumerate the same ordered sources as the renderer.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function editorScriptFiles(webDir) {
  return readFileSync(path.join(webDir, 'editor-scripts.txt'), 'utf8').split('\n')
    .map((line) => line.split('#')[0].trim()).filter(Boolean);
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
