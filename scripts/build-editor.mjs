// Transitional build: real ESM factories plus one ordered legacy scope.
// Portable HTML and localhost embed the same generated classic artifact.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as acorn from 'acorn';
import * as esbuild from 'esbuild';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const BUNDLE = 'editor/boot/editor-bundle.js';
export const BUILD_INFO = 'editor/boot/editor-bundle.meta.json';
// 两个开发 watcher 可同时运行：双方产物和原子发布临时文件都不能触发重建。
export function isBundleArtifact(file) {
  const relative = file.replaceAll('\\', '/');
  return [BUNDLE, BUILD_INFO, 'launcher/boot/launcher-bundle.js',
    'launcher/boot/launcher-bundle.meta.json'].includes(relative)
    || /(?:^|\/)\.maw-bundle-[^/]+\.tmp$/.test(relative);
}
export function shouldRebuildBundle(root, file) {
  if (!file || isBundleArtifact(file)) return false;
  try {
    // Windows 在原子发布文件时还会报告父目录 change，不能把它当作源码变更。
    return !fs.statSync(path.join(root, 'web', file.replaceAll('\\', '/'))).isDirectory();
  } catch {
    // 删除源码或无法读取时仍尝试构建，让构建器报告错误而非静默保留旧产物。
    return true;
  }
}
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const parse = (source, sourceType) => acorn.parse(source, {ecmaVersion:'latest', sourceType});
const FILE_LOADERS = {'.js':'js','.mjs':'js','.cjs':'js','.jsx':'jsx',
  '.ts':'ts','.tsx':'tsx','.json':'json','.css':'css','.txt':'text'};

export const captureBuildInputs = (root, names) => Object.fromEntries(names
  .map(name => [name, fs.readFileSync(path.join(root, name), 'utf8')]));
export const dependencyHash = snapshot => sha(['package.json', 'pnpm-lock.yaml']
  .map(name => snapshot[name]).join('\n'));
export function assertBuildInputsUnchanged(root, snapshot) {
  for (const [name, text] of Object.entries(snapshot)) {
    if (fs.readFileSync(path.join(root, name), 'utf8') !== text) {
      throw new Error(`Build input changed during compilation: ${name}; retry the build`);
    }
  }
}

// Readers must see a complete JS file even when a watch build or another process
// publishes at the same time. Stage both files first; metadata is the commit
// record, published last. Its bundleHash rejects interrupted/mixed generations.
async function replaceFile(source, destination) {
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(source, destination); return; }
    catch (error) {
      // Windows can briefly deny replacement while a page reader or antivirus
      // holds the old file open. Keep the previous complete file while retrying.
      if (attempt >= 100 || !['EPERM','EACCES','EBUSY'].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

export async function writeArtifact(root, bundle, buildInfo, built) {
  const paths = [bundle, buildInfo].map(name => path.join(root, 'web', name));
  fs.mkdirSync(path.dirname(paths[0]), {recursive:true});
  const temporary = paths.map(destination => path.join(path.dirname(destination),
    `.maw-bundle-${randomUUID()}.tmp`));
  try {
    fs.writeFileSync(temporary[0], built.code, {flag:'wx'});
    fs.writeFileSync(temporary[1], json(built.metadata), {flag:'wx'});
    await replaceFile(temporary[0], paths[0]);
    await replaceFile(temporary[1], paths[1]);
  } finally {
    for (const file of temporary) {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

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

function validateInitModule(source, item) {
  if (item.kind !== 'init') return;
  // The initializer body runs at this file's manifest position. Imported
  // modules follow normal ESM evaluation and should keep top-level work declarative.
  const ast = parse(source,'module');
  const imports = ast.body.filter(node => node.type === 'ImportDeclaration');
  const exports = ast.body.filter(node => node.type === 'ExportNamedDeclaration');
  const initializer = exports[0]?.declaration;
  if (imports.length + exports.length !== ast.body.length || exports.length !== 1
      || initializer?.type !== 'FunctionDeclaration'
      || initializer.id?.name !== item.exportName
      || initializer.async || initializer.generator) {
    throw new Error(`Init module must export exactly one function: ${item.file}`);
  }
}

function validateTransitionModule(source, item) {
  if (item.kind !== 'transition') return;
  // Same shape as an init module: exactly one exported function
  // declaration and imports only. The assembler binds the export
  // lexically; evaluation must have no side effects.
  const ast = parse(source,'module');
  const imports = ast.body.filter(node => node.type === 'ImportDeclaration');
  const exports = ast.body.filter(node => node.type === 'ExportNamedDeclaration');
  const exported = exports[0]?.declaration;
  if (imports.length + exports.length !== ast.body.length || exports.length !== 1
      || exported?.type !== 'FunctionDeclaration'
      || exported.id?.name !== item.exportName
      || exported.async || exported.generator) {
    throw new Error(`Transition module must export exactly one function: ${item.file}`);
  }
}

export function assertMetafileInputsCaptured(root, result, inputHashes) {
  for (const input of Object.keys(result.metafile.inputs)) {
    const normalized = input.replace(/\\/g,'/');
    // esbuild reports stdin.sourcefile as an input too, but it is virtual and
    // has no corresponding source file under web/.
    if (normalized === 'web/editor-entry.mjs') continue;
    const absolute = path.normalize(path.resolve(root, normalized));
    const relative = result.loadedInputs.get(absolute);
    if (!relative || !(relative in inputHashes)) {
      throw new Error(`Static import was not captured during compilation: ${input}`);
    }
  }
}

export async function compileSources(root, files, modules, read, options = {}) {
  validateSources(files);
  const webRoot = fs.realpathSync(path.join(root,'web'));
  const loadedInputs = new Map();
  const byFile = new Map(), names = new Set();
  for (const item of modules) {
    if (!files.includes(item.file) || byFile.has(item.file) || names.has(item.name)
        || !/^[A-Za-z_$][\w$]*$/.test(item.exportName) || typeof item.name !== 'string') {
      throw new Error(`Invalid/duplicate factory or omitted source in manifest: ${item.file}`);
    }
    if (item.kind !== undefined && !['factory', 'init', 'transition'].includes(item.kind)) {
      throw new Error(`Unknown module kind: ${item.kind}: ${item.file}`);
    }
    byFile.set(item.file,item); names.add(item.name);
  }
  const sources = new Map(files.map(file => [file,read(file)]));
  // Caller-owned set so a second compile in the same process cannot
  // reuse this call's registration state.
  options.transitionBindings?.clear?.();
  const imports = modules.map((item,index) =>
    `import { ${item.exportName} as factory${index} } from ${JSON.stringify('maw-factory:'+item.file)};`);
  for (const item of modules) {
    if (item.kind === 'init') validateInitModule(sources.get(item.file),item);
    else if (item.kind === 'transition') validateTransitionModule(sources.get(item.file),item);
    else validateModule(sources.get(item.file),item);
  }
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
    if (item?.kind === 'init') {
      const index = modules.indexOf(item);
      body.push(`// Init module: ${file}\nfactory${index}();`);
    } else if (item?.kind === 'transition') {
      // Launcher transitional mechanism: the compiled module replaces the
      // file's slot; its single export becomes a lexical binding the
      // remaining classic scope reads by name at the original position.
      if (!options.transitionBindings || !/^[A-Za-z_$][\w$]*$/.test(item.binding ?? '')) {
        // transitionBindings 缺失说明装配方未启用过渡接入，而不是绑定名非法。
        throw new Error(`Invalid transition binding${options.transitionBindings ? '' : ' (transition support not enabled by this builder)'}: ${item.binding}`);
      }
      if (options.transitionBindings.has(item.binding)) {
        throw new Error(`Duplicate transition binding: ${item.binding}`);
      }
      if (names.has(item.binding)) {
        throw new Error(`Transition binding collides with a module name: ${item.binding}`);
      }
      if (options.bridges?.some(bridge => bridge.name === item.binding)) {
        // 不可变桥的 window getter 会静默捕获同名词法绑定，运行期才暴露。
        throw new Error(`Transition binding collides with an external bridge: ${item.binding}`);
      }
      options.transitionBindings.add(item.binding);
      body.push(`// Transition module: ${file}\nconst ${item.binding} = factory${modules.indexOf(item)};`);
    } else if (item) body.push(`window.MAWE.register(${JSON.stringify(item.name)}, factory${modules.indexOf(item)});`);
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
      build.onResolve({filter:/^\.{1,2}\//}, args => {
        const webRoot = path.resolve(root,'web');
        const resolved = path.resolve(args.resolveDir,args.path);
        if (resolved !== webRoot && !resolved.startsWith(webRoot+path.sep)) {
          return {errors:[{text:`Static import escapes web/: ${args.path}`}]};
        }
        return null;
      });
      build.onLoad({filter:/.*/,namespace:'file'}, args => {
        const lexical = path.relative(path.resolve(root,'web'),args.path).replaceAll('\\','/');
        // compileSources also accepts in-memory factory sources in unit tests.
        // Imported files must exist so their canonical path can be checked.
        const supplied = sources.has(lexical);
        const canonical = supplied ? null : fs.realpathSync(args.path);
        if (!supplied && canonical !== webRoot && !canonical.startsWith(webRoot+path.sep)) {
          throw new Error(`Static import escapes web/: ${args.path}`);
        }
        const relative = supplied ? lexical : path.relative(webRoot,canonical).replaceAll('\\','/');
        const loader = FILE_LOADERS[path.extname(args.path)];
        if (!loader) throw new Error(`Unsupported static import type: ${args.path}`);
        let contents = supplied ? sources.get(relative) : fs.readFileSync(canonical,'utf8');
        if (!supplied) {
          options.onDependency?.(relative,contents);
          // Imported deps compile the transformed text too:
          // hash and bytes given to esbuild must stay
          // identical (review of #288 — hash-only
          // mutation passed tests while the compiled
          // content stayed original).
          contents = options.transform ? options.transform(relative,contents) : contents;
        }
        loadedInputs.set(path.normalize(args.path),relative);
        return {contents,loader,resolveDir:path.dirname(args.path)};
      });
    }}], bundle:true,format:'iife',target:['es2022'],charset:'utf8',minify:true,write:false,
    metafile:true,logLevel:'silent',legalComments:'none',banner:{js:"'use strict';"}});
  return {code:result.outputFiles[0].text,metafile:result.metafile,loadedInputs,sourceFiles:files,modules,entry};
}

export async function buildEditor(root = ROOT, options = {}) {
  const snapshot = captureBuildInputs(root, ['web/editor-scripts.txt', 'web/editor-modules.json',
    'scripts/build-editor.mjs', 'package.json', 'pnpm-lock.yaml']);
  const files = readSources(root), configText = snapshot['web/editor-modules.json'];
  const config = JSON.parse(configText), modules = config.modules, inputHashes = {};
  const result = await compileSources(root,files,modules,file => {
    const original = fs.readFileSync(path.join(root,'web',file),'utf8');
    snapshot['web/'+file] = original;
    const source = options.transform ? options.transform(file,original) : original;
    inputHashes[file] = sha(source); return source;
  },{bridges:config.externalBridges,trace:true,transform:options.transform,onDependency:(relative,original) => {
    const key = 'web/'+relative;
    // Transform hook covers imported inputs too (tests mutate non-manifest
    // sources like shared/utils/data.js after G04 retire). Snapshot keeps
    // the disk bytes for the unchanged check; the hash covers what esbuild
    // consumed (the transformed text).
    if (!Object.hasOwn(snapshot,key)) snapshot[key] = original;
    const source = options.transform ? options.transform(relative,original) : original;
    inputHashes[relative] = sha(source);
  }});
  // The bytes hashed above are the bytes given to esbuild, not a later read.
  assertMetafileInputsCaptured(root,result,inputHashes);
  assertBuildInputsUnchanged(root, snapshot);
  // esbuild resolves imports with worker parallelism, so onDependency
  // fires in nondeterministic order once the manifest no longer lists
  // every module (G04 retire). Sort the ledger so metadata is stable.
  const sortedInputHashes = Object.fromEntries(Object.entries(inputHashes).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0));
  const metadata = {format:1,esbuild:esbuild.version,sourceFiles:files,esmFactories:modules.length,
    inputs:sortedInputHashes,configHash:sha(configText),builderHash:sha(snapshot['scripts/build-editor.mjs']),
    dependencyHash:dependencyHash(snapshot),
    // esbuild sees remaining classic sources as a single transitional scope.
    // Explicit hashes above cover every source, including this virtual input.
    metafile:result.metafile};
  const identity = `/* MAW ESM artifact: ${sha(result.code+json(metadata))} */`;
  metadata.bundleHash = sha(identity+'\n'+result.code);
  return {...result,code:identity+'\n'+result.code,identity,metadata};
}

export function assertFresh(actual, expected) {
  if (actual !== expected) throw new Error('Editor bundle is stale; run pnpm run build:editor');
}

export async function checkEditor(root = ROOT) {
  const built = await buildEditor(root);
  // Bundles are build artifacts (not committed): a missing file is the normal
  // fresh-clone state, so point at the build command instead of "stale".
  if (!fs.existsSync(path.join(root,'web',BUNDLE))) throw new Error('Editor bundle missing; run pnpm run build:editor');
  assertFresh(fs.readFileSync(path.join(root,'web',BUNDLE),'utf8'),built.code);
  assertFresh(fs.readFileSync(path.join(root,'web',BUILD_INFO),'utf8'),json(built.metadata));
  return built;
}

async function writeEditor(root) {
  const built = await buildEditor(root);
  // Write only after the entire build succeeds; never repair while checking.
  await writeArtifact(root, BUNDLE, BUILD_INFO, built);
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
      if (shouldRebuildBundle(root, file)) void rebuild();
    });
    fs.watch(fileURLToPath(import.meta.url), () => {
      console.error('Build script changed; restart pnpm run watch:editor');
    });
  } else throw new Error('Usage: build-editor.mjs --write|--check|--watch [ROOT]');
}
