// Transitional build: real ESM factories plus one ordered legacy scope.
// Portable HTML and localhost embed the same checked-in classic artifact.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as acorn from 'acorn';
import * as esbuild from 'esbuild';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const BUNDLE = 'editor/boot/editor-bundle.js';
export const BUILD_INFO = 'editor/boot/editor-bundle.meta.json';
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const parse = (source, sourceType) => acorn.parse(source, {ecmaVersion:'latest', sourceType});

export function validateSources(files) {
  if (!files.length || new Set(files).size !== files.length) throw new Error('Empty or duplicate source manifest');
  for (const file of files) {
    if (!file.endsWith('.js') || /[\\:]/.test(file) || file.split('/').some(part => ['', '.', '..'].includes(part))
        || file === BUNDLE) throw new Error(`Invalid source path in manifest: ${file}`);
  }
  return files;
}

export function readSources(root = ROOT) {
  const web = fs.realpathSync(path.join(root,'web'));
  const files = validateSources(fs.readFileSync(path.join(web,'editor-scripts.txt'),'utf8').split('\n')
    .map(line => line.split('#')[0].trim()).filter(Boolean));
  for (const file of files) {
    const canonical = fs.realpathSync(path.join(web,file));
    if (!canonical.startsWith(web+path.sep) || !fs.statSync(canonical).isFile()) {
      throw new Error(`Source path escapes web or is not a file: ${file}`);
    }
  }
  return files;
}

export function readModules(root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root,'web/editor-modules.json'),'utf8')).modules;
}

function validateModule(source, item) {
  const ast = parse(source,'module');
  const statement = ast.body[0];
  if (ast.body.length !== 1 || statement?.type !== 'ExportNamedDeclaration'
      || statement.declaration?.type !== 'FunctionDeclaration'
      || statement.declaration.id?.name !== item.exportName
      || statement.declaration.async || statement.declaration.generator) {
    throw new Error(`ESM factory must export ${item.exportName} without evaluation effects: ${item.file}`);
  }
}

export async function compileSources(root, files, modules, read, options = {}) {
  validateSources(files);
  const byFile = new Map(), names = new Set();
  for (const item of modules) {
    if (!files.includes(item.file) || byFile.has(item.file) || names.has(item.name)
        || !/^[A-Za-z_$][\w$]*$/.test(item.exportName) || typeof item.name !== 'string') {
      throw new Error(`Invalid/duplicate factory or omitted source in manifest: ${item.file}`);
    }
    byFile.set(item.file,item); names.add(item.name);
  }
  const sources = new Map(files.map(file => [file,read(file)]));
  const imports = modules.map((item,index) =>
    `import { ${item.exportName} as factory${index} } from ${JSON.stringify('maw-factory:'+item.file)};`);
  for (const item of modules) validateModule(sources.get(item.file),item);
  // Keep lexical declarations INSIDE this function: esbuild otherwise lowers
  // module-level let/const to var and loses the classic scope's TDZ semantics.
  const body = ['function initializeLegacy() {'];
  for (const bridge of options.bridges ?? []) {
    if (!files.includes(bridge.file) || !/^[A-Za-z_$][\w$]*$/.test(bridge.name)) {
      throw new Error(`Invalid external bridge: ${bridge.name}`);
    }
    const setter = bridge.mutable ? `${bridge.name} = value;` : "throw new TypeError('Assignment to constant variable');";
    body.push(`Object.defineProperty(window, ${JSON.stringify(bridge.name)}, {configurable:true,
      get: () => ${bridge.name}, set: value => {${setter}}});`);
  }
  if (options.trace) body.push('window.__mawEsmInitializationTrace = [];');
  for (const file of files) {
    const item = byFile.get(file);
    if (options.beforeEntry === file) body.push('globalThis.__mawBeforeFixture?.(window);');
    if (item) body.push(`window.MAWE.register(${JSON.stringify(item.name)}, factory${modules.indexOf(item)});`);
    else {
      try { parse(sources.get(file),'script'); }
      catch (error) { throw new Error(`Legacy source must remain classic until explicitly migrated: ${file}: ${error.message}`); }
      body.push(`// Legacy scope: ${file}\n${sources.get(file)}\n`);
    }
    if (options.trace) body.push(`window.__mawEsmInitializationTrace.push(${JSON.stringify(file)});`);
  }
  body.push('}', 'initializeLegacy();');
  const entry = [...imports,...body].join('\n')+'\n';
  const result = await esbuild.build({absWorkingDir:path.resolve(root),
    stdin:{contents:entry,resolveDir:path.resolve(root,'web'),sourcefile:'editor-entry.mjs',loader:'js'},
    plugins:[{name:'maw-factories',setup(build) {
      build.onResolve({filter:/^maw-factory:/}, args => ({path:path.resolve(root,'web',args.path.slice(12))}));
      build.onLoad({filter:/\.js$/}, args => {
        const file = path.relative(path.resolve(root,'web'),args.path).replaceAll('\\','/');
        if (!byFile.has(file)) return null;
        return {contents:sources.get(file),loader:'js',resolveDir:path.dirname(args.path)};
      });
    }}], bundle:true,format:'iife',target:['es2022'],charset:'utf8',minify:true,write:false,
    metafile:true,logLevel:'silent',legalComments:'none',banner:{js:"'use strict';"}});
  return {code:result.outputFiles[0].text,metafile:result.metafile,sourceFiles:files,modules,entry};
}

export async function buildEditor(root = ROOT, options = {}) {
  const files = readSources(root), modules = readModules(root);
  const configText = fs.readFileSync(path.join(root,'web/editor-modules.json'),'utf8');
  const config = JSON.parse(configText), inputHashes = {};
  const result = await compileSources(root,files,modules,file => {
    const original = fs.readFileSync(path.join(root,'web',file),'utf8');
    const source = options.transform ? options.transform(file,original) : original;
    inputHashes[file] = sha(source); return source;
  },{bridges:config.externalBridges,trace:true});
  const metadata = {format:1,esbuild:esbuild.version,sourceFiles:files,esmFactories:modules.length,
    inputs:inputHashes,configHash:sha(configText),builderHash:sha(fs.readFileSync(fileURLToPath(import.meta.url))),
    // esbuild sees remaining classic sources as a single transitional scope.
    // Explicit hashes above cover every source, including this virtual input.
    metafile:result.metafile};
  const identity = `/* MAW ESM artifact: ${sha(result.code+json(metadata))} */`;
  return {...result,code:identity+'\n'+result.code,identity,metadata};
}

export function assertFresh(actual, expected) {
  if (actual !== expected) throw new Error('Editor bundle is stale; run pnpm run build:editor');
}

export async function checkEditor(root = ROOT) {
  const built = await buildEditor(root);
  assertFresh(fs.readFileSync(path.join(root,'web',BUNDLE),'utf8'),built.code);
  assertFresh(fs.readFileSync(path.join(root,'web',BUILD_INFO),'utf8'),json(built.metadata));
  return built;
}

async function writeEditor(root) {
  const built = await buildEditor(root);
  // Write only after the entire build succeeds; never repair while checking.
  fs.writeFileSync(path.join(root,'web',BUNDLE),built.code);
  fs.writeFileSync(path.join(root,'web',BUILD_INFO),json(built.metadata));
  console.log(`Editor: ${built.modules.length} ESM factories / ${built.sourceFiles.length} sources`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [mode,rootArg = ROOT] = process.argv.slice(2), root = path.resolve(rootArg);
  if (mode === '--check') { await checkEditor(root); console.log('Editor bundle is fresh'); }
  else if (mode === '--write') await writeEditor(root);
  else if (mode === '--watch') {
    await writeEditor(root);
    let pending = false, running = false;
    const rebuild = async () => {
      pending = true;
      if (running) return;
      running = true;
      while (pending) {
        pending = false;
        try { await writeEditor(root); } catch (error) { console.error(error.message); }
      }
      running = false;
    };
    fs.watch(path.join(root,'web'),{recursive:true},(_event,file) => {
      if (file && ![BUNDLE,BUILD_INFO].includes(file.replaceAll('\\','/'))) void rebuild();
    });
    fs.watch(fileURLToPath(import.meta.url), () => {
      console.error('Build script changed; restart pnpm run watch:editor');
    });
  } else throw new Error('Usage: build-editor.mjs --write|--check|--watch [ROOT]');
}
