// Fail-closed codemod for the first production batch. Dry-run is the default.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as acorn from 'acorn';
import * as eslintScope from 'eslint-scope';
import { convertFactory, inspectSource } from './esm-mechanical/research.mjs';
import { readSources } from './build-editor.mjs';

const ROOT = fileURLToPath(new URL('../',import.meta.url));
const walkFiles = dir => fs.existsSync(dir) ? fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry =>
  entry.isDirectory() ? walkFiles(path.join(dir,entry.name))
    : entry.name.endsWith('.mjs') ? [path.join(dir,entry.name)] : []) : [];

export function planMigration(root = ROOT, selectedFiles) {
  if (fs.existsSync(path.join(root,'web/editor-modules.json'))) throw new Error('Batch already migrated; refusing overwrite');
  if (fs.existsSync(path.join(root,'web/package.json'))) throw new Error('Existing web package scope requires review');
  const files = readSources(root);
  const sources = files.map(file => {
    const source = fs.readFileSync(path.join(root,'web',file),'utf8');
    return {file,source,info:inspectSource(source,file)};
  });
  const owners = new Map();
  for (const item of sources) {
    const ast = acorn.parse(item.source,{ecmaVersion:'latest'});
    for (const node of ast.body) {
      const declarations = node.type === 'VariableDeclaration' ? node.declarations.map(decl => {
        if (decl.id.type !== 'Identifier') throw new Error('Top-level destructuring needs review');
        return {name:decl.id.name,mutable:node.kind !== 'const'};
      }) : node.type === 'FunctionDeclaration' ? [{name:node.id.name,mutable:true}] : [];
      for (const declaration of declarations) {
        if (owners.has(declaration.name)) throw new Error('Duplicate shared declaration: '+declaration.name);
        owners.set(declaration.name,{file:item.file,...declaration});
      }
    }
  }
  if (selectedFiles && (!selectedFiles.length || new Set(selectedFiles).size !== selectedFiles.length
      || selectedFiles.some(file => !sources.some(item => item.file === file && item.info.simpleFactory)))) {
    throw new Error('Selected batch contains missing, duplicate or non-factory inputs');
  }
  // Projection reuses a reviewed batch; new upstream factories stay classic.
  const outputs = sources.filter(item => item.info.simpleFactory
    && (!selectedFiles || selectedFiles.includes(item.file))).map(item => {
    if (!/^(shared\/(host|utils)\/|editor\/media\/waveform\/)/.test(item.file)) {
      throw new Error(`New factory outside the reviewed batch needs review: ${item.file}`);
    }
    const cross = item.info.free.filter(name => owners.has(name));
    if (cross.length) throw new Error(`Factory captures classic bindings: ${item.file}: ${cross.join(',')}`);
    return {file:item.file,...convertFactory(item.source)};
  });
  if (!outputs.length || outputs.length === files.length) throw new Error('Expected a partial factory batch');
  const externalBridges = new Map();
  const external = walkFiles(path.join(root,'tests/e2e'));
  for (const file of external) {
    const sourceType = file.endsWith('.mjs') ? 'module' : 'script';
    const ast = acorn.parse(fs.readFileSync(file,'utf8'),{ecmaVersion:16,sourceType,ranges:true});
    const scope = eslintScope.analyze(ast,{ecmaVersion:16,sourceType});
    for (const ref of scope.globalScope.through) if (owners.has(ref.identifier.name)) {
      externalBridges.set(ref.identifier.name,owners.get(ref.identifier.name));
    }
  }
  return {sourceFiles:files,outputs,config:{format:1,
    modules:outputs.map(({code,...item}) => item),externalBridges:[...externalBridges.values()]}};
}

export function applyMigration(root = ROOT, selectedFiles) {
  const plan = planMigration(root, selectedFiles);
  // All shape, dependency and syntax checks finish before the first write.
  for (const item of plan.outputs) fs.writeFileSync(path.join(root,'web',item.file),item.code);
  fs.writeFileSync(path.join(root,'web/editor-modules.json'),JSON.stringify(plan.config,null,2)+'\n');
  fs.writeFileSync(path.join(root,'web/package.json'),'{"private":true,"type":"module"}\n');
  return {sourceFiles:plan.sourceFiles.length,esmFactories:plan.outputs.length};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [mode = '--plan',rootArg = ROOT] = process.argv.slice(2), root = path.resolve(rootArg);
  if (mode === '--write') console.log(JSON.stringify(applyMigration(root)));
  else if (mode === '--plan') {
    const plan = planMigration(root);
    console.log(JSON.stringify({sourceFiles:plan.sourceFiles.length,modules:plan.config.modules,
      externalBridges:plan.config.externalBridges},null,2));
  } else throw new Error('Usage: migrate-editor-factories.mjs --plan|--write [ROOT]');
}
