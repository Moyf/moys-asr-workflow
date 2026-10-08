// Migrate only loading/assembly checks in an isolated copy. Behavioral test bodies
// and their assertions stay unchanged. Production bundle probes are separate.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '');
if (!fs.existsSync(path.join(root, '.esm-mechanical-sandbox.json'))) throw new Error('Missing sandbox marker');
const helper = `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as esbuild from 'esbuild';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const web = path.join(root, 'web');
const manifest = fs.readFileSync(path.join(web, 'editor-sources.txt'), 'utf8').split('\\n').map(s => s.trim()).filter(Boolean);
const cache = new Map();
function compile(files, entry) {
  const key = files.join(',') + ':' + entry;
  if (cache.has(key)) return cache.get(key);
  const imports = files.map((file, i) => 'import { initialize as init'+i+' } from '+JSON.stringify('./'+file)+';');
  const statements = ['const steps = ['+files.map((file, i) => 'init'+i+'()').join(',')+'];',
    'for (const step of steps) step.next();', ...files.flatMap((file, i) =>
      (file === entry ? ['globalThis.__mawBeforeFixture?.(window);'] : []).concat('steps['+i+'].next();'))];
  const result = esbuild.buildSync({ stdin: {contents: [...imports, ...statements].join('\\n'), resolveDir: web, loader:'js'},
    absWorkingDir: root, bundle:true, format:'iife', write:false, logLevel:'silent', banner:{js: "'use strict';"} });
  const code = result.outputFiles[0].text;
  cache.set(key, code); return code;
}
export function compileEditorFixture(file) { return compile([file], file); }
export function loadEditorModule(context, entry, beforeEntry = () => {}) {
  const directories = entry === 'shared/editor-utils.js' ? ['shared/utils/'] : ['editor/media/waveform/'];
  const files = manifest.filter(name => name === 'editor/boot/editor-runtime.js' || name === 'editor/boot/editor-host.js'
    || name.startsWith('shared/host/') || name === 'shared/gap-remove-core.js' || name === entry
    || directories.some(prefix => name.startsWith(prefix)));
  context.__mawBeforeFixture = beforeEntry;
  try { vm.runInNewContext(compile(files, entry), context); }
  finally { delete context.__mawBeforeFixture; }
  return context.window;
}
`;
fs.writeFileSync(path.join(root, 'tests/helpers/editor-module-loader.mjs'), helper);
const replacements = [
  ['test_editor_host.mjs', "vm.runInNewContext(readFileSync(new URL('../web/' + file, import.meta.url), 'utf8'), context);", 'vm.runInNewContext(compileEditorFixture(file), context);'],
  ['test_editor_state.mjs', "vm.runInNewContext(readFileSync(new URL('../web/' + file, import.meta.url), 'utf8'), context);", 'vm.runInNewContext(compileEditorFixture(file), context);'],
  ['test_editor_commands.mjs', "vm.runInNewContext(readFileSync(new URL('../web/' + file, import.meta.url), 'utf8'), context);", 'vm.runInNewContext(compileEditorFixture(file), context);'],
  ['test_editor_runtime.mjs', "const source = fs.readFileSync(new URL('../web/editor/boot/editor-runtime.js', import.meta.url), 'utf8');", "const source = compileEditorFixture('editor/boot/editor-runtime.js');"],
  ['test_inline_caret.mjs', "vm.runInNewContext(readFileSync(new URL('../web/editor/cues/editor-inline-edit.js', import.meta.url), 'utf8'), context);", "vm.runInNewContext(compileEditorFixture('editor/cues/editor-inline-edit.js'), context);"],
  ['test_editor_utils.mjs', "const i18nSource = fs.readFileSync(new URL('../web/shared/editor-i18n.js', import.meta.url), 'utf8');", "const i18nSource = compileEditorFixture('shared/editor-i18n.js');"],
  ['test_editor_markers.mjs', "vm.runInNewContext(readFileSync(exportPath, 'utf8'), context, { filename: 'editor-export-timeline.js' });", "vm.runInNewContext(compileEditorFixture('editor/io/editor-export-timeline.js'), context, { filename: 'editor-export-timeline.js' });"],
];
for (const [file, before, after] of replacements) {
  const filename = path.join(root, 'tests', file), source = fs.readFileSync(filename, 'utf8');
  if (!source.includes(before)) throw new Error(`Unknown loading shape: ${file}`);
  fs.writeFileSync(filename, "import { compileEditorFixture } from './helpers/editor-module-loader.mjs';\n" + source.replace(before, after));
}
fs.writeFileSync(path.join(root, 'tests/test_editor_script_syntax.mjs'), `import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as acorn from 'acorn';
const web = new URL('../web/', import.meta.url);
const files = fs.readFileSync(new URL('editor-sources.txt', web), 'utf8').trim().split('\\n');
test('all editor sources are valid ESM and the distributed bundle is classic', () => {
  assert.ok(files.length > 1);
  for (const file of files) acorn.parse(fs.readFileSync(new URL(file, web), 'utf8'), {ecmaVersion:16, sourceType:'module'});
  new vm.Script(fs.readFileSync(new URL('editor/boot/editor-bundle.js', web), 'utf8'));
});
`);
fs.writeFileSync(path.join(root, 'tests/test_editor_script_order.mjs'), `import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import * as acorn from 'acorn';
import { buildEditor } from '../scripts/esm-mechanical/full-build.mjs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const web = new URL('../web/', import.meta.url);
test('module evaluation contains declarations only; startup is explicit and artifact is fresh', async () => {
  const built = await buildEditor(root);
  assert.equal(built.code, fs.readFileSync(new URL('editor/boot/editor-bundle.js', web), 'utf8'));
  for (const file of built.sourceFiles) {
    const ast = acorn.parse(fs.readFileSync(new URL(file, web), 'utf8'), {ecmaVersion:16, sourceType:'module'});
    for (const statement of ast.body) {
      assert.ok(statement.type === 'ImportDeclaration' || statement.type === 'ExportNamedDeclaration', file);
      if (statement.declaration?.type === 'VariableDeclaration')
        assert.ok(statement.declaration.declarations.every(d => d.init === null), file+' eagerly initializes shared state');
    }
    const startup = ast.body.find(s => s.declaration?.id?.name === 'initialize');
    assert.ok(startup?.declaration.generator, file+' lacks staged initialization');
  }
});
`);
console.log('Migrated loaders and the two retired classic assembly checks; behavioral assertions retained');
