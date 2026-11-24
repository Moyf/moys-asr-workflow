// Editor build entry and transitional fixture readers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { assertBuildInputsUnchanged, assertMetafileInputsCaptured, captureBuildInputs, compileSources,
  dependencyHash, isBundleArtifact, json, sha, shouldRebuildBundle, validateSources, writeArtifact } from './build-shared.mjs';

export { compileSources, isBundleArtifact, shouldRebuildBundle, validateSources, writeArtifact } from './build-shared.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const BUNDLE = 'editor/boot/editor-bundle.js';
export const BUILD_INFO = 'editor/boot/editor-bundle.meta.json';
export const BUILDERS = ['scripts/build-editor.mjs', 'scripts/build-shared.mjs'];

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

export async function buildLegacyEditor(root = ROOT, options = {}) {
  const snapshot = captureBuildInputs(root, ['web/editor-scripts.txt', 'web/editor-modules.json',
    ...BUILDERS, 'package.json', 'pnpm-lock.yaml']);
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
    inputs:sortedInputHashes,configHash:sha(configText),builderHash:sha(BUILDERS.map(name => snapshot[name]).join('\n')),
    dependencyHash:dependencyHash(snapshot),
    // esbuild sees remaining classic sources as a single transitional scope.
    // Explicit hashes above cover every source, including this virtual input.
    metafile:result.metafile};
  const identity = `/* MAW ESM artifact: ${sha(result.code+json(metadata))} */`;
  metadata.bundleHash = sha(identity+'\n'+result.code);
  return {...result,code:identity+'\n'+result.code,identity,metadata};
}

export const ENTRY = 'editor/boot/editor-entry.mjs';
const LOADERS = {'.js':'js', '.mjs':'js', '.cjs':'js', '.jsx':'jsx',
  '.ts':'ts', '.tsx':'tsx', '.json':'json', '.css':'css', '.txt':'text'};

function editorDiscovery(webRoot) {
  const files = [];
  const links = [];
  const packageHashes = {};
  function walk(directory) {
    for (const entry of fs.readdirSync(path.join(webRoot, directory), {withFileTypes:true})) {
      const name = directory ? directory + '/' + entry.name : entry.name;
      if (isBundleArtifact(name)) continue;
      if (entry.name === 'package.json' && entry.isSymbolicLink()) {
        throw new Error(`Editor package configuration cannot be a symbolic link: ${name}`);
      }
      if (entry.isDirectory()) walk(name);
      else if (entry.isSymbolicLink()) links.push(name);
      else {
        // Even an unsupported exact file can shadow a previously resolved
        // extension candidate. Hash only files esbuild actually reads.
        files.push(name);
        if (entry.isFile() && entry.name === 'package.json') {
          packageHashes[name] = sha(fs.readFileSync(path.join(webRoot, name), 'utf8'));
        }
      }
    }
  }
  walk('');
  return {files:files.sort(), links:links.sort(), packages:Object.fromEntries(Object.entries(packageHashes).sort())};
}

export async function buildEditor(root = ROOT, options = {}) {
  root = path.resolve(root);
  const webRoot = fs.realpathSync(path.join(root, 'web'));
  const snapshot = captureBuildInputs(root, [...BUILDERS, 'package.json', 'pnpm-lock.yaml']);
  const discovery = editorDiscovery(webRoot);
  const inputs = {};
  const loadedInputs = new Map();
  const compiled = await esbuild.build({
    absWorkingDir:root, entryPoints:['web/' + ENTRY],
    bundle:true, format:'iife', target:['es2022'], charset:'utf8', minify:true, write:false,
    metafile:true, logLevel:'silent', legalComments:'none', banner:{js:"'use strict';"},
    preserveSymlinks:true, tsconfigRaw:{},
    plugins:[{name:'maw-editor-inputs',setup(build) {
      build.onResolve({filter:/.*/}, args => {
        if (args.kind === 'entry-point') return null;
        if (args.path.startsWith('#')) return null;
        if (!/^\.{1,2}\//.test(args.path) || !path.resolve(args.resolveDir, args.path).startsWith(webRoot + path.sep)) {
          return {errors:[{text:`Editor import must be relative and stay in web/: ${args.path}`}]};
        }
        return null;
      });
      build.onLoad({filter:/.*/,namespace:'file'}, args => {
        const absolute = path.normalize(args.path);
        const relative = path.relative(webRoot, absolute).replaceAll('\\', '/');
        if (!absolute.startsWith(webRoot + path.sep) || fs.realpathSync(absolute) !== absolute) {
          throw new Error(`Editor import escapes web/ or uses a symbolic link: ${relative}`);
        }
        const loader = LOADERS[path.extname(relative)];
        if (!loader || isBundleArtifact(relative)) throw new Error(`Unsupported editor source: ${relative}`);
        const original = fs.readFileSync(absolute, 'utf8');
        snapshot['web/' + relative] = original;
        const contents = options.transform ? options.transform(relative, original) : original;
        inputs[relative] = sha(contents);
        loadedInputs.set(absolute, relative);
        return {contents, loader, resolveDir:path.dirname(absolute)};
      });
    }}],
  });
  const result = {metafile:compiled.metafile,loadedInputs};
  assertMetafileInputsCaptured(root, result, inputs, null);
  assertBuildInputsUnchanged(root, snapshot);
  if (json(discovery) !== json(editorDiscovery(webRoot))) {
    throw new Error('Editor source discovery changed during compilation; retry the build');
  }
  const sourceFiles = Object.keys(inputs).sort();
  const metadata = {
    format:2, esbuild:esbuild.version, entry:ENTRY, sourceFiles,
    inputs:Object.fromEntries(sourceFiles.map(file => [file, inputs[file]])),
    discovery, builderHash:sha(BUILDERS.map(name => snapshot[name]).join('\n')),
    dependencyHash:dependencyHash(snapshot), metafile:compiled.metafile,
  };
  const output = compiled.outputFiles[0].text;
  const identity = `/* MAW ESM artifact: ${sha(output + json(metadata))} */`;
  const code = identity + '\n' + output;
  metadata.bundleHash = sha(code);
  return {code,identity,metadata,sourceFiles,metafile:compiled.metafile};
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
  console.log(`Editor: ${built.sourceFiles.length} imported sources`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [mode,rootArg = ROOT] = process.argv.slice(2), root = path.resolve(rootArg);
  if (mode === '--check') { await checkEditor(root); console.log('Editor bundle is fresh'); }
  else if (mode === '--write') await writeEditor(root);
  else if (mode === '--legacy-write') await writeArtifact(root, BUNDLE, BUILD_INFO, await buildLegacyEditor(root));
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
    for (const builder of BUILDERS) fs.watch(path.join(root, builder), () => {
      console.error('Build script changed; restart pnpm run watch:editor');
    });
  } else throw new Error('Usage: build-editor.mjs --write|--check|--watch [ROOT]');
}
