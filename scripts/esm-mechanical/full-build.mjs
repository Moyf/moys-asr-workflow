// Complete ESM graph -> one classic artifact. Importing/checking never writes.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import * as esbuild from 'esbuild';

export const BUNDLE = 'editor/boot/editor-bundle.js';
export function sourceFiles(root) {
  const files = fs.readFileSync(path.join(root, 'web/editor-sources.txt'), 'utf8').split('\n')
    .map(line => line.split('#')[0].trim()).filter(Boolean);
  if (!files.length || new Set(files).size !== files.length) throw new Error('Empty or duplicate source manifest');
  for (const file of files) {
    if (!file.endsWith('.js') || /[\\:]/.test(file) || file.split('/').some(p => ['', '.', '..'].includes(p))) {
      throw new Error(`Invalid source path: ${file}`);
    }
    const target = path.join(root, 'web', file);
    const canonical = fs.realpathSync(target);
    if (!canonical.startsWith(fs.realpathSync(path.join(root, 'web')) + path.sep)) throw new Error('Source escapes web');
  }
  return files;
}

export async function buildEditor(root) {
  const files = sourceFiles(root);
  const imports = files.map((file, i) => `import { initialize as init${i} } from './${file}';`);
  const conversion = JSON.parse(fs.readFileSync(path.join(root, 'full-conversion.json'), 'utf8'));
  const externalBridges = conversion.externalBridges ?? [];
  const bridgeOwners = [...new Set(externalBridges.map(b => b.file))];
  imports.push(...bridgeOwners.map((file, i) => `import { legacyBindings as externalBindings${i} } from './${file}';`));
  const bridges = externalBridges.map(b => {
    const alias = `externalBindings${bridgeOwners.indexOf(b.file)}.${b.name}`;
    const setter = b.mutable ? `${alias} = value;` : `throw new TypeError('Assignment to constant variable');`;
    return `Object.defineProperty(window, ${JSON.stringify(b.name)}, { configurable: true, get: () => ${alias}, set: value => { ${setter} } });`;
  });
  const calls = ['window.__mawEsmInitializationTrace = [];',
    `const initializationSteps = [${files.map((file, i) => `init${i}()`).join(',')}];`,
    'for (const step of initializationSteps) step.next();', ...bridges, ...files.flatMap((file, i) => [
    `initializationSteps[${i}].next();`, `window.__mawEsmInitializationTrace.push(${JSON.stringify(file)});`,
  ])];
  const entry = [...imports, ...calls].join('\n') + '\n';
  const result = await esbuild.build({ absWorkingDir: path.resolve(root),
    stdin: { contents: entry, resolveDir: path.resolve(root, 'web'), sourcefile: 'editor-entry.mjs', loader: 'js' },
    bundle: true, format: 'iife', target: ['chrome120'], write: false, metafile: true,
    logLevel: 'silent', legalComments: 'none', banner: { js: "'use strict';" } });
  const body = result.outputFiles[0].text;
  const identity = `/* MAW ESM artifact: ${createHash('sha256').update(body).digest('hex')} */`;
  return { code: identity + '\n' + body, identity, metafile: result.metafile, sourceFiles: files, entry };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const [mode, rootArg] = process.argv.slice(2);
  if (!['--write', '--check'].includes(mode) || !rootArg) throw new Error('Usage: full-build.mjs --write|--check ROOT');
  const root = path.resolve(rootArg), output = path.join(root, 'web', BUNDLE);
  const result = await buildEditor(root);
  if (mode === '--check') {
    if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== result.code) throw new Error('Full bundle is stale');
    console.log('Full bundle is fresh');
  } else {
    const marker = path.join(root, '.esm-mechanical-sandbox.json');
    if (!fs.existsSync(marker) || JSON.parse(fs.readFileSync(marker, 'utf8')).purpose !== 'esm-mechanical-research') {
      throw new Error('Writing is restricted to an isolated research copy');
    }
    fs.writeFileSync(output, result.code);
    fs.writeFileSync(path.join(root, 'full-metafile.json'), JSON.stringify(result.metafile, null, 2) + '\n');
    console.log(JSON.stringify({ sourceFiles: result.sourceFiles.length, bytes: Buffer.byteLength(result.code) }));
  }
}
