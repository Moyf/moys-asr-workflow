import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await fs.mkdir(path.join(root, '.artifacts/filmstrip'), { recursive: true });
await build({
  entryPoints: [path.join(root, 'web/experiments/filmstrip/lab.mjs')],
  bundle: true, format: 'iife', target: 'es2022',
  plugins: [{ name: 'wave-scale', setup(b) {
    b.onResolve({ filter: /^\/scale\.mjs$/ }, () => ({ path: path.join(root, 'web/editor/media/waveform/scale.js') }));
  }}],
  outfile: path.join(root, '.artifacts/filmstrip/lab-inline.js'),
});
console.log('Filmstrip portable experiment bundle built (ignored artifact).');
