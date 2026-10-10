import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const builder = new URL('../scripts/build-editor.mjs', import.meta.url);
const artifact = path.join(root, 'web/editor/boot/editor-bundle.js');

test('upstream projection freezes the reviewed batch and rejects incomplete selections', async () => {
  const {planMigration} = await import('../scripts/migrate-editor-factories.mjs');
  fs.mkdirSync(path.join(root, '.worktrees'), {recursive:true});
  const folder = fs.mkdtempSync(path.join(root, '.worktrees/factory-batch-'));
  fs.mkdirSync(path.join(folder, 'web/shared/utils'), {recursive:true});
  fs.mkdirSync(path.join(folder, 'web/shared/new-domain'), {recursive:true});
  const reviewed = 'shared/utils/reviewed.js', incoming = 'shared/new-domain/incoming.js';
  const registration = name => `window.MAWE.register('${name}', function createExample(dependencies) { return {value:dependencies.value}; });`;
  fs.writeFileSync(path.join(folder, 'web/editor-scripts.txt'), `${reviewed}\n${incoming}\n`);
  fs.writeFileSync(path.join(folder, 'web', reviewed), registration('reviewed'));
  fs.writeFileSync(path.join(folder, 'web', incoming), registration('incoming'));
  assert.throws(() => planMigration(folder), /outside.*reviewed/i);
  const plan = planMigration(folder, [reviewed]);
  assert.deepEqual(plan.config.modules.map(module => module.file), [reviewed]);
  assert.deepEqual(plan.sourceFiles, [reviewed, incoming]);
  for (const files of [[], [reviewed,reviewed], ['missing.js']]) {
    assert.throws(() => planMigration(folder, files), /missing|duplicate|non-factory/i);
  }
  fs.writeFileSync(path.join(folder, 'web', reviewed), 'window.effect = true;');
  assert.throws(() => planMigration(folder, [reviewed]), /non-factory/i);
});

test('production editor uses an explicit partial ESM batch and one fresh classic artifact', async () => {
  const { buildEditor, readSources } = await import(builder);
  const result = await buildEditor(root);
  assert.equal(result.code, fs.readFileSync(artifact, 'utf8'));
  new vm.Script(result.code);
  assert.equal(result.sourceFiles.length, readSources(root).length);
  assert.ok(result.modules.length > 5 && result.modules.length < result.sourceFiles.length);
  for (const module of result.modules) {
    assert.ok(Object.keys(result.metafile.inputs).includes(`web/${module.file}`), module.file);
  }
});

test('partial assembly preserves hoisting, TDZ, writes and registration slots', async () => {
  const { compileSources } = await import(builder);
  const files = ['first.js', 'factory.js', 'last.js'];
  const source = new Map([
    ['first.js', `window.events=['first']; window.forward=hoisted(); window.preVar=laterVar;
      try { window.preLet=laterLet; } catch(e) { window.tdz=e.name; }
      window.MAWE={register(name, factory) { window.events.push(name); window.factory=factory; }};`],
    ['factory.js', `export function createExample(deps) { return {read: () => deps.current()}; }`],
    ['last.js', `var laterVar=9; let laterLet=2; const fixed=3;
      function hoisted(){return 42;} window.postfix=laterLet++; laterLet+=4;
      window.read=() => laterLet; window.value=window.factory({current:window.read}).read();
      window.shadow=(function(laterLet){return ++laterLet;})(40);
      try {window.fixed++;} catch(e){window.constError=e.name;} window.events.push('last');`],
  ]);
  const modules = [{file:'factory.js', name:'example', exportName:'createExample'}];
  const { code } = await compileSources(root, files, modules, file => source.get(file),
    {bridges:[{file:'last.js',name:'fixed',mutable:false}]});
  const context = {window:{}};
  vm.runInNewContext(code, context);
  assert.deepEqual([...context.window.events], ['first','example','last']);
  assert.equal(context.window.forward,42);
  assert.equal(context.window.preVar,undefined);
  assert.equal(context.window.tdz,'ReferenceError');
  assert.equal(context.window.postfix,2);
  assert.equal(context.window.value,7);
  assert.equal(context.window.shadow,41);
  assert.equal(context.window.constError,'TypeError');
});

test('source-only changes invalidate the artifact and module evaluation has no effects', async () => {
  const { buildEditor, assertFresh, readModules } = await import(builder);
  const original = fs.readFileSync(artifact,'utf8');
  assert.throws(() => assertFresh(original+'// stale\n', original), /stale/i);
  const changed = await buildEditor(root, { transform(file, source) {
    return file === 'shared/utils/data.js' ? source.replace('moy.asr.project.v1','deliberately.stale') : source;
  }});
  assert.notEqual(changed.code,original);
  assert.equal(fs.readFileSync(artifact,'utf8'),original);
  for (const item of readModules(root)) {
    const imported = await import(new URL('../web/'+item.file,import.meta.url));
    assert.equal(typeof imported[item.exportName],'function');
  }
});

test('assembly rejects invalid exports, effects, duplicate/unsafe paths and omitted modules', async () => {
  const { compileSources, validateSources, buildEditor } = await import(builder);
  for (const files of [[], ['same.js','same.js'], ['../outside.js'], ['.env'], ['C:/file.js']]) {
    assert.throws(() => validateSources(files), /manifest|path/i);
  }
  await assert.rejects(compileSources(root,['factory.js'],[{file:'factory.js',name:'example',exportName:'missing'}],
    () => 'export function createExample() {}'), /export/i);
  await assert.rejects(compileSources(root,['factory.js'],[{file:'factory.js',name:'example',exportName:'createExample'}],
    () => 'window.effect=true; export function createExample() {}'), /effect|factory/i);
  await assert.rejects(compileSources(root,['other.js'],[{file:'factory.js',name:'example',exportName:'createExample'}],
    () => ''), /manifest/i);
  await assert.rejects(compileSources(root,['constant.js'],[],() => 'const fixed=3; fixed++;'), /constant/i);
  await assert.rejects(buildEditor(root,{transform(file, source) {
    return file === 'editor/boot/editor-runtime.js' ? source+'\nexport const accidental=1;' : source;
  }}), /classic|export/i);
});
